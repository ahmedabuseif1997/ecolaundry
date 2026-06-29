const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3001;
const MAX_PER_SLOT = 3;

// ── Twilio SMS (optional) ─────────────────────────────────────────────────────
const TWILIO_SID   = 'YOUR_TWILIO_ACCOUNT_SID';
const TWILIO_TOKEN = 'YOUR_TWILIO_AUTH_TOKEN';
const TWILIO_FROM  = 'YOUR_TWILIO_PHONE_NUMBER';

// ── Google Reviews link ───────────────────────────────────────────────────────
const REVIEWS_URL = 'https://g.page/r/YOUR_GOOGLE_PLACE_ID/review';

// ── Paths ─────────────────────────────────────────────────────────────────────
const D         = path.join(__dirname, 'data');
const PHOTOS    = path.join(D, 'photos');
const BFILE     = path.join(D, 'bookings.csv');
const FFILE     = path.join(D, 'fleet.csv');
const AVAIL     = path.join(D, 'availability.json');
const LOYALTY   = path.join(D, 'loyalty.json');
const REFERRALS = path.join(D, 'referrals.json');

function init() {
  [D, PHOTOS].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));
  if (!fs.existsSync(BFILE)) fs.writeFileSync(BFILE, 'Date Received,Name,Phone,Service,Code,Booking Date,Time,Emirate,Address,Total,Status,Referral Used,Loyalty Points\n');
  if (!fs.existsSync(FFILE)) fs.writeFileSync(FFILE, 'Date Received,Company,Contact,Phone,Vehicles,Details,Status\n');
  if (!fs.existsSync(AVAIL))     fs.writeFileSync(AVAIL,     '{}');
  if (!fs.existsSync(LOYALTY))   fs.writeFileSync(LOYALTY,   '{}');
  if (!fs.existsSync(REFERRALS)) fs.writeFileSync(REFERRALS, '{}');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function csv(fields) { return fields.map(f => '"' + String(f || '').replace(/"/g, '""') + '"').join(',') + '\n'; }
function dubaTime() { return new Date().toLocaleString('en-AE', { timeZone: 'Asia/Dubai' }); }
function makeCode(name) {
  const clean = (name || 'CLIENT').replace(/\s+/g, '').toUpperCase().slice(0, 6);
  return clean + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}
function pts(code) { return { A: 1, B: 2, C: 5, D: 3 }[code] || 1; }

// ── SMS via Twilio ─────────────────────────────────────────────────────────────
function sendSMS(to, body) {
  if (!TWILIO_SID || TWILIO_SID.startsWith('YOUR_')) return;
  const clean = to.replace(/[\s-]/g, '');
  const data = `To=${encodeURIComponent(clean)}&From=${encodeURIComponent(TWILIO_FROM)}&Body=${encodeURIComponent(body)}`;
  const req = https.request({
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    method: 'POST',
    auth: `${TWILIO_SID}:${TWILIO_TOKEN}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
  }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => console.log('SMS:', r.statusCode)); });
  req.on('error', e => console.log('SMS error:', e.message));
  req.write(data); req.end();
}

// ── CORS + JSON response ───────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function body(req) {
  return new Promise((ok, fail) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { ok(JSON.parse(b)); } catch { fail(new Error('bad json')); } });
  });
}

// ── Static files ──────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };
function staticFile(res, filePath, dl) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const h = { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' };
    if (dl) h['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
    cors(res); res.writeHead(200, h); res.end(data);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────
init();
http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname, query } = url.parse(req.url, true);

  // ── GET /api/slots?date=YYYY-MM-DD ──────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/slots') {
    const avail = readJSON(AVAIL);
    const day = query.date || '';
    const booked = avail[day] || {};
    const ALL = ['8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM'];
    const slots = ALL.map(s => ({ time: s, available: (booked[s] || 0) < MAX_PER_SLOT }));
    return json(res, slots);
  }

  // ── GET /api/loyalty?phone=xxx ───────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/loyalty') {
    const loy = readJSON(LOYALTY);
    const phone = query.phone || '';
    const data = loy[phone] || { points: 0, totalWashes: 0, referralCode: makeCode(phone), freeWashes: 0 };
    if (!loy[phone]) { loy[phone] = data; saveJSON(LOYALTY, loy); }
    return json(res, data);
  }

  // ── GET /api/validate-referral?code=xxx ─────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/validate-referral') {
    const refs = readJSON(REFERRALS);
    const code = (query.code || '').toUpperCase();
    const ref = refs[code];
    return json(res, ref ? { valid: true, owner: ref.ownerName } : { valid: false });
  }

  // ── POST /api/booking ────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/booking') {
    try {
      const d = await body(req);

      // Check slot availability
      const avail = readJSON(AVAIL);
      const day = d.Date || '';
      if (!avail[day]) avail[day] = {};
      const count = avail[day][d.Time] || 0;
      if (count >= MAX_PER_SLOT) return json(res, { ok: false, reason: 'slot_full' });

      // Save booking
      const row = csv([dubaTime(), d.Name, d.Phone, d.Service, d.Code, d.Date, d.Time, d.Emirate, d.Address, d.Total, 'Pending', d.ReferralCode || '', pts(d.Code)]);
      fs.appendFileSync(BFILE, row);

      // Update availability
      avail[day][d.Time] = count + 1;
      saveJSON(AVAIL, avail);

      // Update loyalty
      const loy = readJSON(LOYALTY);
      const phone = d.Phone;
      if (!loy[phone]) loy[phone] = { points: 0, totalWashes: 0, referralCode: makeCode(d.Name), freeWashes: 0 };
      loy[phone].points = (loy[phone].points || 0) + pts(d.Code);
      loy[phone].totalWashes = (loy[phone].totalWashes || 0) + 1;

      // Check free wash redemption
      if (loy[phone].points >= 10) {
        loy[phone].freeWashes = (loy[phone].freeWashes || 0) + Math.floor(loy[phone].points / 10);
        loy[phone].points = loy[phone].points % 10;
      }

      // Handle referral
      const refs = readJSON(REFERRALS);
      const refCode = (d.ReferralCode || '').toUpperCase();
      if (refCode && refs[refCode] && refs[refCode].ownerPhone !== phone) {
        const ownerPhone = refs[refCode].ownerPhone;
        if (loy[ownerPhone]) loy[ownerPhone].points = (loy[ownerPhone].points || 0) + 2;
        loy[phone].points = (loy[phone].points || 0) + 1;
        refs[refCode].uses = (refs[refCode].uses || 0) + 1;
        saveJSON(REFERRALS, refs);
      }

      // Register customer referral code if new
      const myCode = loy[phone].referralCode;
      if (!refs[myCode]) { refs[myCode] = { ownerPhone: phone, ownerName: d.Name, uses: 0 }; saveJSON(REFERRALS, refs); }
      saveJSON(LOYALTY, loy);

      // Send SMS confirmation
      sendSMS(d.Phone, `Hi ${d.Name}! ✅ Your Eco-Clean booking is confirmed.\n📅 ${d.Date} at ${d.Time}\n📍 ${d.Emirate}, ${d.Address}\n🚗 ${d.Service}\nWe'll be there! Call us: +971 58 285 9762`);

      console.log(`✅ Booking: ${d.Name} | ${d.Service} | ${d.Date} ${d.Time} | Points: ${loy[phone].points}`);
      return json(res, { ok: true, points: loy[phone].points, totalWashes: loy[phone].totalWashes, referralCode: loy[phone].referralCode, freeWashes: loy[phone].freeWashes });
    } catch (e) { return json(res, { ok: false }, 500); }
  }

  // ── POST /api/fleet ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/fleet') {
    try {
      const d = await body(req);
      fs.appendFileSync(FFILE, csv([dubaTime(), d.Company, d.Contact, d.Phone, d.Vehicles, d.Details, 'New']));
      sendSMS(d.Phone, `Hi ${d.Contact}! 🚛 Eco-Clean received your fleet quotation request for ${d.Vehicles}. Our B2B team will call you within 24 hours. +971 58 285 9762`);
      console.log(`✅ Fleet inquiry: ${d.Company} | ${d.Vehicles}`);
      return json(res, { ok: true });
    } catch (e) { return json(res, { ok: false }, 500); }
  }

  // ── POST /api/photo ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/photo') {
    try {
      const d = await body(req);
      const name = `${d.bookingId || Date.now()}_${d.type || 'photo'}.jpg`;
      const base64 = (d.data || '').replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(PHOTOS, name), Buffer.from(base64, 'base64'));
      console.log(`📸 Photo saved: ${name}`);
      return json(res, { ok: true, file: name });
    } catch (e) { return json(res, { ok: false }, 500); }
  }

  // ── POST /api/complete ───────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/complete') {
    try {
      const d = await body(req);
      // Update booking status in CSV
      const content = fs.readFileSync(BFILE, 'utf8');
      const updated = content.replace(new RegExp(`(${d.name}.*?)Pending`), '$1Completed');
      fs.writeFileSync(BFILE, updated);
      // Send review request SMS
      if (d.phone) {
        sendSMS(d.phone, `Hi ${d.name}! 🚗✨ Your Eco-Clean wash is done! We'd love your feedback — leave us a quick Google review: ${REVIEWS_URL}\nThank you! 🌿`);
      }
      console.log(`✅ Job completed: ${d.name}`);
      return json(res, { ok: true });
    } catch (e) { return json(res, { ok: false }, 500); }
  }

  // ── GET /api/jobs?date=YYYY-MM-DD ────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/jobs') {
    const date = query.date || new Date().toISOString().split('T')[0];
    const formatted = new Date(date + 'T00:00:00').toLocaleDateString('en-AE', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    const content = fs.readFileSync(BFILE, 'utf8');
    const lines = content.trim().split('\n').slice(1);
    const jobs = lines.filter(l => l.includes(formatted) || l.includes(date)).map(line => {
      const cols = [];let cur='',inQ=false;
      for(let i=0;i<line.length;i++){
        if(line[i]==='"'){inQ=!inQ;}
        else if(line[i]===','&&!inQ){cols.push(cur);cur='';}
        else cur+=line[i];
      }
      cols.push(cur);
      return { received: cols[0], name: cols[1], phone: cols[2], service: cols[3], code: cols[4], date: cols[5], time: cols[6], emirate: cols[7], address: cols[8], total: cols[9], status: cols[10] };
    });
    return json(res, jobs);
  }

  // ── GET /api/stats ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/stats') {
    const loy = readJSON(LOYALTY);
    const refs = readJSON(REFERRALS);
    const totalCustomers = Object.keys(loy).length;
    const totalReferrals = Object.values(refs).reduce((s, r) => s + (r.uses || 0), 0);
    const topReferrers = Object.entries(refs).sort((a, b) => (b[1].uses || 0) - (a[1].uses || 0)).slice(0, 5).map(([code, r]) => ({ code, name: r.ownerName, uses: r.uses || 0 }));
    return json(res, { totalCustomers, totalReferrals, topReferrers });
  }

  // ── Downloads ─────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/data/bookings.csv') return staticFile(res, BFILE, true);
  if (req.method === 'GET' && pathname === '/data/fleet.csv')    return staticFile(res, FFILE, true);

  // ── Pages ─────────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/admin') return staticFile(res, path.join(__dirname, 'admin.html'), false);
  if (req.method === 'GET' && pathname === '/team')  return staticFile(res, path.join(__dirname, 'team.html'), false);
  if (req.method === 'GET' && pathname === '/photos') return staticFile(res, path.join(__dirname, 'photos.html'), false);

  // ── Static files ──────────────────────────────────────────────────────────────
  const filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  staticFile(res, filePath, false);

}).listen(PORT, () => {
  console.log('\n🚗 Eco-Clean is live!\n');
  console.log(`  Customer app   → http://localhost:${PORT}`);
  console.log(`  Admin panel    → http://localhost:${PORT}/admin`);
  console.log(`  Team app       → http://localhost:${PORT}/team`);
  console.log(`  Photo gallery  → http://localhost:${PORT}/photos\n`);
  console.log(`  SMS: ${TWILIO_SID.startsWith('YOUR') ? '⚠️  not configured' : '✅ active'}`);
  console.log(`  Slots/team: ${MAX_PER_SLOT}\n`);
});
