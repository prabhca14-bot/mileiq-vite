import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const CRA_RATE_PER_KM = 0.70;
const STORAGE_KEY = "mileiq_clone_v3";

// Smart motion detection thresholds
const MOTION_START_SPEED_KMH = 8;        // Must exceed 8 km/h to count as driving
const MOTION_STOP_SPEED_KMH = 3;         // Below 3 km/h = potentially stopped
const DEAD_STOP_DURATION_MS = 45000;     // Must be still for 45 seconds = true journey end
const MIN_TRIP_KM = 0.3;                 // Ignore trips under 300m

const VEHICLE_PRESETS = [
  { name: "Sedan (avg)", l100: 9.5 },
  { name: "SUV / Truck", l100: 13.0 },
  { name: "Compact", l100: 7.5 },
  { name: "Hybrid", l100: 5.0 },
  { name: "Van / Minivan", l100: 12.0 },
  { name: "Custom", l100: null },
];

const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmt$ = (v) => `$${Math.abs(v).toFixed(2)}`;
const fmtKm = (v) => `${Number(v).toFixed(1)} km`;
const nowDate = () => new Date().toISOString().slice(0, 10);

function calcTrip(km, fuelPrice, l100) {
  return {
    fuelCost: (km / 100) * l100 * fuelPrice,
    craValue: km * CRA_RATE_PER_KM,
  };
}

function isWorkHour(dateStr, timeStr, workHours) {
  if (!workHours.enabled || !timeStr) return false;
  const date = new Date(`${dateStr}T${timeStr}`);
  const day = date.getDay();
  const hour = date.getHours() + date.getMinutes() / 60;
  return workHours.days.includes(day) && hour >= workHours.start && hour < workHours.end;
}

function haversine(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

// ─── Reverse Geocode via Nominatim (free, no API key) ─────────────────────────
async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=16&addressdetails=1`,
      { headers: { "Accept-Language": "en", "User-Agent": "MileIQClone/1.0" } }
    );
    const data = await res.json();
    const a = data.address || {};
    // Build a human-readable name: shop/amenity > road + suburb > neighbourhood > city
    const poi = a.amenity || a.shop || a.building || a.office || a.tourism || a.leisure || "";
    const road = a.road || a.pedestrian || a.path || "";
    const suburb = a.suburb || a.neighbourhood || a.hamlet || a.village || "";
    const city = a.city || a.town || a.municipality || a.county || "";

    if (poi && road) return `${poi}, ${road}`;
    if (poi && suburb) return `${poi}, ${suburb}`;
    if (poi) return `${poi}, ${city}`;
    if (road && suburb) return `${road}, ${suburb}`;
    if (road && city) return `${road}, ${city}`;
    if (suburb && city) return `${suburb}, ${city}`;
    return city || data.display_name?.split(",").slice(0,2).join(",") || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  }
}

// ─── CSV Export ───────────────────────────────────────────────────────────────
function exportCSV(trips) {
  const header = ["Date","Time","From","To","KM","Duration","Category","Fuel Cost","CRA Value"];
  const rows = trips.map((t) => [
    t.date, t.time || "", t.from, t.to,
    t.km.toFixed(1), t.duration, t.category || "unclassified",
    t.fuelCost.toFixed(2), t.craValue.toFixed(2),
  ]);
  const csv = [header, ...rows].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `mileage-report-${nowDate()}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─── SwipeCard ────────────────────────────────────────────────────────────────
function SwipeCard({ trip, onClassify }) {
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [gone, setGone] = useState(null);
  const startX = useRef(null);

  const go = (dir) => { setGone(dir); setTimeout(() => onClassify(trip.id, dir), 340); };
  const onStart = (x) => { startX.current = x; setDragging(true); };
  const onMove = (x) => { if (dragging && startX.current != null) setDrag(x - startX.current); };
  const onEnd = () => {
    if (drag > 80) go("business"); else if (drag < -80) go("personal");
    setDrag(0); setDragging(false); startX.current = null;
  };

  const tx = gone === "business" ? 500 : gone === "personal" ? -500 : drag;
  const rot = drag / 20;

  return (
    <div
      onMouseDown={(e) => onStart(e.clientX)} onMouseMove={(e) => onMove(e.clientX)}
      onMouseUp={onEnd} onMouseLeave={onEnd}
      onTouchStart={(e) => onStart(e.touches[0].clientX)}
      onTouchMove={(e) => onMove(e.touches[0].clientX)} onTouchEnd={onEnd}
      style={{ transform:`translateX(${tx}px) rotate(${rot}deg)`, opacity:gone?0:1,
        transition:dragging?"none":"all 0.34s cubic-bezier(.68,-.55,.27,1.55)", cursor:"grab", userSelect:"none" }}
      className="swipe-card"
    >
      {drag > 45 && <div className="swipe-hint biz-hint">💼 BUSINESS</div>}
      {drag < -45 && <div className="swipe-hint per-hint">🏠 PERSONAL</div>}
      <div className="card-top">
        <div>
          <div className="card-date">{trip.date}{trip.time ? ` · ${trip.time}` : ""}</div>
          <div className="card-route">{trip.from} → {trip.to}</div>
        </div>
        <div className="card-km">{fmtKm(trip.km)}</div>
      </div>
      {trip.autoClassified && <div className="auto-badge">⚡ Auto-classified by work hours</div>}
      <div className="card-stats">
        <div className="cstat"><span className="cstat-l">Fuel Cost</span><span className="cstat-v fuel">{fmt$(trip.fuelCost)}</span></div>
        <div className="cstat"><span className="cstat-l">CRA Value</span><span className="cstat-v cra">{fmt$(trip.craValue)}</span></div>
        <div className="cstat"><span className="cstat-l">Duration</span><span className="cstat-v">{trip.duration}</span></div>
      </div>
      <div className="swipe-guide">
        <span>← Personal</span><span style={{fontSize:"10px",opacity:.4}}>swipe to classify</span><span>Business →</span>
      </div>
      <div className="quick-btns">
        <button className="qbtn personal-btn" onClick={(e) => { e.stopPropagation(); go("personal"); }}>🏠 Personal</button>
        <button className="qbtn business-btn" onClick={(e) => { e.stopPropagation(); go("business"); }}>💼 Business</button>
      </div>
    </div>
  );
}

// ─── Smart GPS Modal ──────────────────────────────────────────────────────────
function GPSModal({ onTrip, onClose, fuelPrice, vehicle, workHours }) {
  // status: idle | waiting | driving | stopped | saving | done | error
  const [status, setStatus] = useState("idle");
  const [fromName, setFromName] = useState("");
  const [toName, setToName] = useState("");
  const [liveKm, setLiveKm] = useState(0);
  const [liveSpeed, setLiveSpeed] = useState(0);
  const [stopCountdown, setStopCountdown] = useState(0); // seconds remaining until auto-stop
  const [autoMode, setAutoMode] = useState(true);
  const [note, setNote] = useState("");

  const watchId = useRef(null);
  const positions = useRef([]);
  const startTime = useRef(null);
  const startCoords = useRef(null);
  const stoppedAt = useRef(null);       // timestamp when vehicle first slowed
  const countdownTimer = useRef(null);
  const kmRef = useRef(0);

  const clearCountdown = () => {
    if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
    setStopCountdown(0);
    stoppedAt.current = null;
  };

  const finishTrip = useCallback(async (lastCoords) => {
    if (watchId.current) navigator.geolocation.clearWatch(watchId.current);
    clearCountdown();
    setStatus("saving");

    const km = Math.max(kmRef.current, 0);
    if (km < MIN_TRIP_KM) { setStatus("idle"); return; }

    // Reverse geocode both endpoints
    const [from, to] = await Promise.all([
      reverseGeocode(startCoords.current.lat, startCoords.current.lon),
      reverseGeocode(lastCoords.lat, lastCoords.lon),
    ]);

    setFromName(from);
    setToName(to);

    const endTime = new Date();
    const mins = Math.round((endTime - startTime.current) / 60000);
    const { fuelCost, craValue } = calcTrip(km, fuelPrice, vehicle.l100);
    const timeStr = startTime.current.toTimeString().slice(0,5);
    const autoCategory = isWorkHour(nowDate(), timeStr, workHours) ? "business" : null;

    onTrip({
      id: Date.now(), from, to, km, fuelCost, craValue,
      date: nowDate(), time: timeStr,
      duration: `${mins} min`, note,
      category: autoCategory, autoClassified: !!autoCategory, gpsTracked: true,
    });
    setStatus("done");
  }, [fuelPrice, vehicle, workHours, note, onTrip]);

  const startTracking = () => {
    if (!navigator.geolocation) { setStatus("error"); return; }
    setStatus(autoMode ? "waiting" : "driving");
    startTime.current = new Date();

    navigator.geolocation.getCurrentPosition((pos) => {
      const c = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      startCoords.current = c;
      positions.current = [c];
      kmRef.current = 0;

      watchId.current = navigator.geolocation.watchPosition((p) => {
        const speedKmh = (p.coords.speed || 0) * 3.6; // m/s → km/h
        const newPos = { lat: p.coords.latitude, lon: p.coords.longitude };
        setLiveSpeed(Math.round(speedKmh));

        if (autoMode) {
          // ── AUTO MODE: smart start detection ──
          if (status === "waiting" || status === "idle") {
            if (speedKmh >= MOTION_START_SPEED_KMH) {
              // Vehicle genuinely moving — start trip
              if (!startCoords.current) { startCoords.current = newPos; startTime.current = new Date(); }
              setStatus("driving");
            }
          }
        }

        if (positions.current.length > 0) {
          const last = positions.current[positions.current.length - 1];
          const seg = haversine(last, newPos);
          if (seg < 1) { // sanity check: ignore GPS jumps > 1km per reading
            kmRef.current += seg;
            setLiveKm(kmRef.current);
          }
        }
        positions.current.push(newPos);

        // ── STOP DETECTION ──
        if (speedKmh <= MOTION_STOP_SPEED_KMH) {
          if (!stoppedAt.current) {
            stoppedAt.current = Date.now();
            // Start countdown timer
            let remaining = DEAD_STOP_DURATION_MS / 1000;
            setStopCountdown(remaining);
            countdownTimer.current = setInterval(() => {
              remaining -= 1;
              setStopCountdown(remaining);
              if (remaining <= 0) {
                clearInterval(countdownTimer.current);
                if (autoMode) finishTrip(newPos);
              }
            }, 1000);
          }
        } else {
          // Moving again — cancel stop countdown
          clearCountdown();
          setStatus("driving");
        }
      }, null, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
    }, () => setStatus("error"), { enableHighAccuracy: true });
  };

  const manualStop = () => {
    const last = positions.current[positions.current.length - 1] || startCoords.current;
    finishTrip(last);
  };

  useEffect(() => () => {
    if (watchId.current) navigator.geolocation.clearWatch(watchId.current);
    clearCountdown();
  }, []);

  const speedColor = liveSpeed > 60 ? "#f59e0b" : liveSpeed > 20 ? "#3dd6f5" : "#10b981";

  return (
    <div className="modal-backdrop" onClick={status === "idle" ? onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">📍 Smart GPS Tracker</div>

        {status === "idle" && (
          <>
            <div className="gps-info">
              Auto-detects when your journey starts and ends. Ignores red lights and traffic stops — only a true {Math.round(DEAD_STOP_DURATION_MS/1000)}s standstill ends the trip.
            </div>
            <div className="mode-toggle">
              <button className={`mode-btn ${autoMode ? "active" : ""}`} onClick={() => setAutoMode(true)}>
                <span>🤖 Auto</span>
                <small>Detects motion automatically</small>
              </button>
              <button className={`mode-btn ${!autoMode ? "active" : ""}`} onClick={() => setAutoMode(false)}>
                <span>✋ Manual</span>
                <small>You tap start & stop</small>
              </button>
            </div>
            <div className="modal-field" style={{marginTop:12}}>
              <label>Trip Note (optional)</label>
              <input placeholder="e.g. Client visit downtown" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button className="btn-primary" onClick={startTracking}>
              {autoMode ? "🚗 Begin — Auto-detect journey" : "🚗 Start Tracking Now"}
            </button>
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
          </>
        )}

        {status === "waiting" && (
          <>
            <div className="gps-pulse"><div className="pulse-ring"/><div className="pulse-dot" style={{background:"#f59e0b"}}/></div>
            <div className="gps-status" style={{color:"#f59e0b"}}>Waiting for movement…</div>
            <div className="gps-sub">Trip will auto-start when you reach {MOTION_START_SPEED_KMH} km/h</div>
            <div className="live-speed" style={{color:"#f59e0b"}}>{liveSpeed} <span>km/h</span></div>
            <button className="btn-danger" onClick={() => { if(watchId.current) navigator.geolocation.clearWatch(watchId.current); setStatus("idle"); }}>Cancel</button>
          </>
        )}

        {(status === "driving" || status === "stopped") && (
          <>
            <div className="gps-pulse">
              <div className="pulse-ring" style={{borderColor: status==="stopped"?"#f59e0b":"#3dd6f5"}}/>
              <div className="pulse-dot" style={{background: status==="stopped"?"#f59e0b":"#3dd6f5"}}/>
            </div>

            {status === "driving" ? (
              <div className="gps-status">🚗 Journey in progress</div>
            ) : (
              <div className="gps-status" style={{color:"#f59e0b"}}>⏸ Stopped — waiting…</div>
            )}

            <div className="live-stats">
              <div className="live-stat">
                <div className="live-val" style={{color:"#3dd6f5"}}>{fmtKm(liveKm)}</div>
                <div className="live-lbl">Distance</div>
              </div>
              <div className="live-stat">
                <div className="live-val" style={{color: speedColor}}>{liveSpeed}</div>
                <div className="live-lbl">km/h</div>
              </div>
              <div className="live-stat">
                <div className="live-val" style={{color:"#10b981"}}>{fmt$(calcTrip(liveKm,fuelPrice,vehicle.l100).craValue)}</div>
                <div className="live-lbl">CRA so far</div>
              </div>
            </div>

            {status === "stopped" && stopCountdown > 0 && (
              <div className="stop-countdown">
                <div className="countdown-bar" style={{width:`${(stopCountdown/(DEAD_STOP_DURATION_MS/1000))*100}%`}}/>
                <div className="countdown-text">
                  Auto-ending trip in <strong>{stopCountdown}s</strong> · Still driving? Keep moving!
                </div>
              </div>
            )}

            <button className="btn-danger" onClick={manualStop}>⏹ End Trip Now</button>
          </>
        )}

        {status === "saving" && (
          <>
            <div className="gps-pulse"><div className="pulse-ring" style={{borderColor:"#10b981"}}/><div className="pulse-dot" style={{background:"#10b981"}}/></div>
            <div className="gps-status" style={{color:"#10b981"}}>Looking up locations…</div>
            <div className="gps-sub">Reverse geocoding your start & end points</div>
          </>
        )}

        {status === "done" && (
          <>
            <div className="gps-done">✅ Trip Saved!</div>
            <div className="done-route">
              <div className="done-place">🟢 {fromName}</div>
              <div className="done-arrow">↓</div>
              <div className="done-place">🔴 {toName}</div>
            </div>
            <div className="gps-result">{fmtKm(liveKm)}</div>
            <button className="btn-primary" onClick={onClose}>Done</button>
          </>
        )}

        {status === "error" && (
          <div className="gps-error">⚠️ GPS not available. Please enable Location Services in your iPhone Settings → Safari → Location.</div>
        )}
      </div>
    </div>
  );
}

// ─── Add Trip Modal ───────────────────────────────────────────────────────────
function AddTripModal({ onAdd, onClose, fuelPrice, vehicle, workHours }) {
  const [form, setForm] = useState({ from:"", to:"", km:"", date:nowDate(), time:"", duration:"" });
  const set = (k,v) => setForm(f => ({...f,[k]:v}));

  const submit = () => {
    if (!form.from || !form.to || !form.km) return;
    const km = parseFloat(form.km);
    const { fuelCost, craValue } = calcTrip(km, fuelPrice, vehicle.l100);
    const autoCategory = isWorkHour(form.date, form.time, workHours) ? "business" : null;
    onAdd({ id:Date.now(), ...form, km, fuelCost, craValue, category:autoCategory, autoClassified:!!autoCategory });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Log a Drive</div>
        {[["From","from","text","Starting location"],["To","to","text","Destination"],
          ["Distance (km)","km","number","e.g. 24.5"],["Date","date","date",""],
          ["Time (optional)","time","time",""],["Duration","duration","text","e.g. 28 min"]
        ].map(([label,key,type,ph]) => (
          <div className="modal-field" key={key}>
            <label>{label}</label>
            <input type={type} placeholder={ph} value={form[key]} onChange={(e) => set(key, e.target.value)} />
          </div>
        ))}
        {form.time && isWorkHour(form.date, form.time, workHours) && (
          <div className="auto-notice">⚡ Will auto-classify as Business (work hours)</div>
        )}
        <button className="btn-primary" onClick={submit}>Add Drive</button>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Settings Modal ───────────────────────────────────────────────────────────
function SettingsModal({ vehicle, setVehicle, workHours, setWorkHours, onClose }) {
  const [customL100, setCustomL100] = useState(vehicle.l100 || 10);
  const isCustom = vehicle.name === "Custom";
  const toggleDay = (d) => setWorkHours(w => ({
    ...w, days: w.days.includes(d) ? w.days.filter(x=>x!==d) : [...w.days, d]
  }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">⚙️ Settings</div>
        <div className="settings-section">
          <div className="settings-heading">🚗 Vehicle</div>
          <div className="vehicle-grid">
            {VEHICLE_PRESETS.map((v) => (
              <button key={v.name} className={`vehicle-btn ${vehicle.name===v.name?"active":""}`}
                onClick={() => setVehicle(v.name==="Custom"?{name:"Custom",l100:customL100}:v)}>
                <span className="vbtn-name">{v.name}</span>
                {v.l100 && <span className="vbtn-l100">{v.l100}L/100km</span>}
              </button>
            ))}
          </div>
          {isCustom && (
            <div className="modal-field" style={{marginTop:10}}>
              <label>Custom L/100km</label>
              <input type="number" value={customL100}
                onChange={(e) => { setCustomL100(parseFloat(e.target.value)); setVehicle({name:"Custom",l100:parseFloat(e.target.value)}); }} />
            </div>
          )}
        </div>
        <div className="settings-section">
          <div className="settings-heading" style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>⚡ Work Hours Auto-Classify</span>
            <button className={`toggle-btn ${workHours.enabled?"on":""}`}
              onClick={() => setWorkHours(w => ({...w,enabled:!w.enabled}))}>{workHours.enabled?"ON":"OFF"}</button>
          </div>
          {workHours.enabled && (
            <>
              <div className="day-picker">
                {DAYS.map((d,i) => (
                  <button key={d} className={`day-btn ${workHours.days.includes(i)?"active":""}`}
                    onClick={() => toggleDay(i)}>{d}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:10,marginTop:10}}>
                <div className="modal-field" style={{flex:1,margin:0}}>
                  <label>Start</label>
                  <input type="time" value={`${String(Math.floor(workHours.start)).padStart(2,"0")}:00`}
                    onChange={(e) => setWorkHours(w => ({...w,start:parseInt(e.target.value)}))} />
                </div>
                <div className="modal-field" style={{flex:1,margin:0}}>
                  <label>End</label>
                  <input type="time" value={`${String(Math.floor(workHours.end)).padStart(2,"0")}:00`}
                    onChange={(e) => setWorkHours(w => ({...w,end:parseInt(e.target.value)}))} />
                </div>
              </div>
            </>
          )}
        </div>
        <button className="btn-primary" onClick={onClose}>Save & Close</button>
      </div>
    </div>
  );
}

// ─── Default data ─────────────────────────────────────────────────────────────
const makeDefault = (l100, fuelPrice) => [
  { id:1, from:"Home", to:"Downtown Office", km:18.4, date:"2026-05-19", time:"08:45", duration:"28 min", ...calcTrip(18.4,fuelPrice,l100), category:null },
  { id:2, from:"Office", to:"Client – Bay St", km:6.2, date:"2026-05-19", time:"13:10", duration:"14 min", ...calcTrip(6.2,fuelPrice,l100), category:null },
  { id:3, from:"Bay St", to:"Grocery Store", km:4.1, date:"2026-05-18", time:"18:30", duration:"10 min", ...calcTrip(4.1,fuelPrice,l100), category:null },
  { id:4, from:"Home", to:"Airport – YYZ", km:41.7, date:"2026-05-17", time:"06:20", duration:"52 min", ...calcTrip(41.7,fuelPrice,l100), category:null },
];

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const load = () => { try { const s=localStorage.getItem(STORAGE_KEY); return s?JSON.parse(s):null; } catch { return null; } };
  const saved = load();

  const [fuelPrice, setFuelPrice] = useState(saved?.fuelPrice ?? 1.72);
  const [vehicle, setVehicle] = useState(saved?.vehicle ?? VEHICLE_PRESETS[0]);
  const [workHours, setWorkHours] = useState(saved?.workHours ?? {enabled:false,days:[1,2,3,4,5],start:8,end:18});
  const [trips, setTrips] = useState(() => saved?.trips ?? makeDefault(VEHICLE_PRESETS[0].l100, 1.72));
  const [tab, setTab] = useState("log");
  const [modal, setModal] = useState(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({trips,fuelPrice,vehicle,workHours})); } catch {}
  }, [trips,fuelPrice,vehicle,workHours]);

  const recalc = useCallback((price, l100) => {
    setTrips(ts => ts.map(t => ({...t,...calcTrip(t.km,price,l100)})));
  }, []);

  const handleFuelPrice = (v) => { setFuelPrice(v); recalc(v, vehicle.l100); };
  const handleVehicle = (v) => { setVehicle(v); recalc(fuelPrice, v.l100); };
  const classify = (id, cat) => setTrips(ts => ts.map(t => t.id===id?{...t,category:cat}:t));
  const addTrip = (t) => setTrips(ts => [t,...ts]);

  const pending = trips.filter(t => !t.category);
  const classified = trips.filter(t => t.category);
  const business = classified.filter(t => t.category==="business");
  const personal = classified.filter(t => t.category==="personal");
  const totalBizKm = business.reduce((s,t)=>s+t.km,0);
  const totalBizCRA = business.reduce((s,t)=>s+t.craValue,0);
  const totalFuel = trips.reduce((s,t)=>s+t.fuelCost,0);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        body{background:#070d19;color:#e8eaf0;font-family:'DM Sans',sans-serif;min-height:100vh}
        .app{max-width:430px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column;background:#0b1020}

        .hdr{padding:18px 18px 14px;background:linear-gradient(160deg,#0d1322,#111827);border-bottom:1px solid rgba(255,255,255,.06)}
        .hdr-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
        .logo{font-family:'Syne',sans-serif;font-weight:800;font-size:22px;letter-spacing:-.5px}
        .logo span{color:#3dd6f5}
        .hdr-actions{display:flex;gap:8px;align-items:center}
        .icon-btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:10px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;transition:background .2s}
        .icon-btn:hover{background:rgba(255,255,255,.12)}
        .badge{background:#3dd6f5;color:#070d19;font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;font-family:'Syne',sans-serif}

        .stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
        .sbox{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:10px;text-align:center}
        .sbox-v{font-family:'Syne',sans-serif;font-weight:700;font-size:15px;color:#3dd6f5}
        .sbox-l{font-size:9px;color:rgba(255,255,255,.38);text-transform:uppercase;letter-spacing:.6px;margin-top:2px}

        .fuel-bar{display:flex;align-items:center;gap:10px;background:rgba(61,214,245,.06);border:1px solid rgba(61,214,245,.16);border-radius:10px;padding:8px 13px;margin-bottom:10px}
        .fuel-lbl{font-size:13px;white-space:nowrap}
        .fuel-slider{flex:1;height:4px;accent-color:#3dd6f5;cursor:pointer}
        .fuel-val{font-family:'Syne',sans-serif;font-weight:700;font-size:14px;color:#3dd6f5;min-width:60px;text-align:right}
        .veh-chip{display:flex;align-items:center;gap:8px;font-size:11px;color:rgba(255,255,255,.45)}
        .veh-name{color:#a78bfa;font-weight:500}

        .tabs{display:flex;padding:12px 18px 0;gap:4px;background:#0b1020}
        .tab{flex:1;padding:9px;border:none;border-radius:10px 10px 0 0;font-family:'Syne',sans-serif;font-weight:600;font-size:13px;cursor:pointer;background:transparent;color:rgba(255,255,255,.38);border-bottom:2px solid transparent;transition:all .2s}
        .tab.active{color:#3dd6f5;border-bottom-color:#3dd6f5}

        .content{flex:1;padding:14px 18px 100px;overflow-y:auto}
        .section-title{font-family:'Syne',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:rgba(255,255,255,.28);margin:14px 0 10px}

        .swipe-card{background:linear-gradient(145deg,#131b2e,#182035);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:16px 18px 12px;margin-bottom:13px;position:relative;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.4)}
        .swipe-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#3dd6f5,#6366f1)}
        .swipe-hint{position:absolute;top:14px;font-family:'Syne',sans-serif;font-weight:800;font-size:11px;padding:3px 9px;border-radius:6px;letter-spacing:1px}
        .biz-hint{right:14px;background:rgba(61,214,245,.18);color:#3dd6f5;border:1px solid rgba(61,214,245,.35)}
        .per-hint{left:14px;background:rgba(239,68,68,.18);color:#f87171;border:1px solid rgba(239,68,68,.35)}
        .card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
        .card-date{font-size:10px;color:rgba(255,255,255,.32);margin-bottom:3px}
        .card-route{font-family:'Syne',sans-serif;font-weight:600;font-size:14px}
        .card-km{font-family:'Syne',sans-serif;font-weight:800;font-size:22px;color:#3dd6f5}
        .auto-badge{font-size:10px;color:#a78bfa;background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.25);border-radius:6px;padding:3px 8px;margin-bottom:10px;display:inline-block}
        .card-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px}
        .cstat{text-align:center}
        .cstat-l{display:block;font-size:9px;color:rgba(255,255,255,.32);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
        .cstat-v{font-family:'Syne',sans-serif;font-weight:700;font-size:13px}
        .cstat-v.fuel{color:#f59e0b}
        .cstat-v.cra{color:#10b981}
        .swipe-guide{display:flex;justify-content:space-between;font-size:10px;color:rgba(255,255,255,.2);border-top:1px solid rgba(255,255,255,.05);padding-top:8px;margin-bottom:8px}
        .quick-btns{display:flex;gap:8px}
        .qbtn{flex:1;padding:8px;border:none;border-radius:10px;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;cursor:pointer;transition:opacity .2s}
        .qbtn:hover{opacity:.85}
        .personal-btn{background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.25)}
        .business-btn{background:rgba(61,214,245,.12);color:#3dd6f5;border:1px solid rgba(61,214,245,.25)}

        .trip-row{display:flex;align-items:center;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:11px 13px;margin-bottom:7px;gap:11px}
        .trip-ico{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
        .trip-ico.business{background:rgba(61,214,245,.1)}
        .trip-ico.personal{background:rgba(239,68,68,.1)}
        .trip-info{flex:1;min-width:0}
        .trip-route{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .trip-meta{font-size:10px;color:rgba(255,255,255,.32);margin-top:2px}
        .trip-cost{text-align:right;flex-shrink:0}
        .trip-cost-main{font-family:'Syne',sans-serif;font-weight:700;font-size:13px;color:#f59e0b}
        .trip-cost-cra{font-size:10px;color:#10b981;margin-top:2px}

        .sum-card{background:linear-gradient(135deg,rgba(61,214,245,.08),rgba(99,102,241,.08));border:1px solid rgba(61,214,245,.18);border-radius:16px;padding:18px;margin-bottom:13px}
        .sum-title{font-family:'Syne',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:rgba(255,255,255,.45);margin-bottom:12px}
        .sum-big{font-family:'Syne',sans-serif;font-weight:800;font-size:36px;color:#10b981;margin-bottom:3px}
        .sum-sub{font-size:12px;color:rgba(255,255,255,.45);margin-bottom:14px}
        .sum-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
        .sum-item{background:rgba(0,0,0,.25);border-radius:10px;padding:11px}
        .sum-item-v{font-family:'Syne',sans-serif;font-weight:700;font-size:17px;margin-bottom:2px}
        .sum-item-l{font-size:10px;color:rgba(255,255,255,.38)}
        .export-btn{width:100%;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:12px;padding:13px;color:#10b981;font-family:'Syne',sans-serif;font-weight:700;font-size:14px;cursor:pointer;transition:background .2s;margin-top:4px}
        .export-btn:hover{background:rgba(16,185,129,.2)}

        .fab-area{position:fixed;bottom:26px;right:calc(50% - 215px + 18px);display:flex;flex-direction:column;align-items:flex-end;gap:10px;z-index:100}
        .fab{width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#3dd6f5,#6366f1);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 8px 28px rgba(61,214,245,.35);transition:transform .2s}
        .fab:hover{transform:scale(1.08)}
        .fab-gps{width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#10b981,#059669);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 6px 20px rgba(16,185,129,.35);transition:transform .2s}
        .fab-gps:hover{transform:scale(1.08)}

        .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:flex-end;z-index:200;backdrop-filter:blur(5px)}
        .modal{background:#131c30;border:1px solid rgba(255,255,255,.1);border-radius:24px 24px 0 0;padding:26px 22px 36px;width:100%;max-width:430px;margin:0 auto;max-height:88vh;overflow-y:auto}
        .settings-modal{max-height:90vh}
        .modal-title{font-family:'Syne',sans-serif;font-weight:800;font-size:19px;margin-bottom:18px}
        .modal-field{margin-bottom:13px}
        .modal-field label{display:block;font-size:10px;color:rgba(255,255,255,.42);text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px}
        .modal-field input{width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:11px 13px;color:#fff;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;transition:border-color .2s}
        .modal-field input:focus{border-color:#3dd6f5}
        .auto-notice{background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.25);border-radius:8px;padding:9px 12px;font-size:12px;color:#a78bfa;margin-bottom:13px}
        .btn-primary{width:100%;background:linear-gradient(135deg,#3dd6f5,#6366f1);border:none;border-radius:12px;padding:13px;color:#fff;font-family:'Syne',sans-serif;font-weight:700;font-size:14px;cursor:pointer;margin-bottom:9px;transition:opacity .2s}
        .btn-primary:hover{opacity:.9}
        .btn-danger{width:100%;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);border-radius:12px;padding:13px;color:#f87171;font-family:'Syne',sans-serif;font-weight:700;font-size:14px;cursor:pointer;margin-bottom:9px}
        .btn-ghost{width:100%;background:transparent;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:11px;color:rgba(255,255,255,.45);font-family:'DM Sans',sans-serif;font-size:13px;cursor:pointer}

        /* GPS SPECIFIC */
        .gps-info{font-size:13px;color:rgba(255,255,255,.55);margin-bottom:16px;line-height:1.6;background:rgba(61,214,245,.05);border:1px solid rgba(61,214,245,.12);border-radius:10px;padding:12px}
        .mode-toggle{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px}
        .mode-btn{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px;cursor:pointer;color:#e8eaf0;text-align:center;transition:all .2s}
        .mode-btn span{display:block;font-family:'Syne',sans-serif;font-weight:700;font-size:14px;margin-bottom:4px}
        .mode-btn small{display:block;font-size:10px;color:rgba(255,255,255,.4);line-height:1.3}
        .mode-btn.active{background:rgba(61,214,245,.1);border-color:rgba(61,214,245,.35);color:#3dd6f5}
        .mode-btn.active small{color:rgba(61,214,245,.7)}

        .gps-pulse{display:flex;justify-content:center;margin:20px 0 14px;position:relative;height:60px;align-items:center}
        .pulse-dot{width:22px;height:22px;border-radius:50%;background:#3dd6f5;position:relative;z-index:1}
        .pulse-ring{position:absolute;width:60px;height:60px;border-radius:50%;border:2px solid #3dd6f5;animation:pulseRing 1.4s ease-out infinite;top:50%;left:50%;transform:translate(-50%,-50%)}
        @keyframes pulseRing{0%{transform:translate(-50%,-50%) scale(.6);opacity:1}100%{transform:translate(-50%,-50%) scale(1.8);opacity:0}}
        .gps-status{text-align:center;font-family:'Syne',sans-serif;font-weight:700;font-size:17px;margin-bottom:6px;color:#3dd6f5}
        .gps-sub{text-align:center;font-size:12px;color:rgba(255,255,255,.38);margin-bottom:20px}

        .live-speed{text-align:center;font-family:'Syne',sans-serif;font-weight:800;font-size:42px;margin-bottom:20px}
        .live-speed span{font-size:14px;opacity:.6}
        .live-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
        .live-stat{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:12px;text-align:center}
        .live-val{font-family:'Syne',sans-serif;font-weight:800;font-size:18px;margin-bottom:4px}
        .live-lbl{font-size:9px;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.6px}

        .stop-countdown{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:10px;padding:10px 12px;margin-bottom:14px;overflow:hidden;position:relative}
        .countdown-bar{height:3px;background:#f59e0b;border-radius:2px;margin-bottom:8px;transition:width 1s linear}
        .countdown-text{font-size:12px;color:rgba(255,255,255,.6);text-align:center}
        .countdown-text strong{color:#f59e0b}

        .gps-done{text-align:center;font-family:'Syne',sans-serif;font-weight:700;font-size:20px;margin:10px 0 16px}
        .done-route{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px;margin-bottom:14px}
        .done-place{font-size:14px;font-weight:500;padding:4px 0}
        .done-arrow{color:rgba(255,255,255,.25);font-size:18px;text-align:center;padding:6px 0}
        .gps-result{text-align:center;font-family:'Syne',sans-serif;font-weight:800;font-size:32px;color:#3dd6f5;margin-bottom:20px}
        .gps-error{color:#f87171;text-align:center;padding:20px 0;font-size:13px;line-height:1.6}

        .settings-section{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:15px;margin-bottom:14px}
        .settings-heading{font-family:'Syne',sans-serif;font-weight:700;font-size:13px;margin-bottom:13px}
        .vehicle-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
        .vehicle-btn{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:10px 12px;cursor:pointer;text-align:left;transition:all .2s;color:#e8eaf0}
        .vehicle-btn.active{background:rgba(61,214,245,.1);border-color:rgba(61,214,245,.35);color:#3dd6f5}
        .vbtn-name{display:block;font-family:'Syne',sans-serif;font-weight:600;font-size:12px}
        .vbtn-l100{display:block;font-size:10px;color:rgba(255,255,255,.38);margin-top:2px}
        .vehicle-btn.active .vbtn-l100{color:rgba(61,214,245,.7)}
        .toggle-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:4px 12px;color:rgba(255,255,255,.5);font-family:'Syne',sans-serif;font-weight:700;font-size:12px;cursor:pointer;transition:all .2s}
        .toggle-btn.on{background:rgba(61,214,245,.15);border-color:rgba(61,214,245,.35);color:#3dd6f5}
        .day-picker{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}
        .day-btn{width:38px;height:34px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:rgba(255,255,255,.4);font-size:11px;font-family:'Syne',sans-serif;font-weight:600;cursor:pointer;transition:all .2s}
        .day-btn.active{background:rgba(61,214,245,.12);border-color:rgba(61,214,245,.3);color:#3dd6f5}
        .empty{text-align:center;padding:36px 20px;color:rgba(255,255,255,.22);font-size:13px}
        .empty-icon{font-size:38px;margin-bottom:10px}
      `}</style>

      <div className="app">
        <div className="hdr">
          <div className="hdr-top">
            <div className="logo">Mile<span>IQ</span></div>
            <div className="hdr-actions">
              {pending.length > 0 && <div className="badge">{pending.length} pending</div>}
              <button className="icon-btn" onClick={() => setModal("settings")}>⚙️</button>
            </div>
          </div>
          <div className="stats-row">
            <div className="sbox"><div className="sbox-v">{fmtKm(totalBizKm)}</div><div className="sbox-l">Business</div></div>
            <div className="sbox"><div className="sbox-v">{fmt$(totalBizCRA)}</div><div className="sbox-l">CRA Value</div></div>
            <div className="sbox"><div className="sbox-v">{fmt$(totalFuel)}</div><div className="sbox-l">Fuel Cost</div></div>
          </div>
          <div className="fuel-bar">
            <span className="fuel-lbl">⛽ Fuel/L</span>
            <input type="range" min="1.20" max="2.50" step="0.01" value={fuelPrice}
              onChange={(e) => handleFuelPrice(parseFloat(e.target.value))} className="fuel-slider"/>
            <span className="fuel-val">${fuelPrice.toFixed(2)}</span>
          </div>
          <div className="veh-chip">
            🚗 <span className="veh-name">{vehicle.name}</span>&nbsp;·&nbsp;{vehicle.l100}L/100km
            {workHours.enabled && <span style={{marginLeft:8,color:"#a78bfa"}}>⚡ Work hours ON</span>}
          </div>
        </div>

        <div className="tabs">
          <button className={`tab ${tab==="log"?"active":""}`} onClick={() => setTab("log")}>Drive Log</button>
          <button className={`tab ${tab==="summary"?"active":""}`} onClick={() => setTab("summary")}>Summary</button>
        </div>

        <div className="content">
          {tab==="log" && (
            <>
              {pending.length>0 && (<><div className="section-title">Needs Classification</div>{pending.map(t=><SwipeCard key={t.id} trip={t} onClassify={classify}/>)}</>)}
              {classified.length>0 && (
                <><div className="section-title">Classified Drives</div>
                {classified.map(t=>(
                  <div key={t.id} className="trip-row">
                    <div className={`trip-ico ${t.category}`}>{t.category==="business"?"💼":"🏠"}</div>
                    <div className="trip-info">
                      <div className="trip-route">{t.from} → {t.to}</div>
                      <div className="trip-meta">{t.date}{t.time?` · ${t.time}`:""} · {fmtKm(t.km)} · {t.duration}</div>
                    </div>
                    <div className="trip-cost">
                      <div className="trip-cost-main">{fmt$(t.fuelCost)}</div>
                      {t.category==="business" && <div className="trip-cost-cra">CRA {fmt$(t.craValue)}</div>}
                    </div>
                  </div>
                ))}</>
              )}
              {trips.length===0 && <div className="empty"><div className="empty-icon">🚗</div>No drives yet. Tap 📍 to auto-track or + to log manually.</div>}
            </>
          )}
          {tab==="summary" && (
            <>
              <div className="sum-card">
                <div className="sum-title">CRA Deduction Potential</div>
                <div className="sum-big">{fmt$(totalBizCRA)}</div>
                <div className="sum-sub">from {business.length} business drive{business.length!==1?"s":""}</div>
                <div className="sum-grid">
                  <div className="sum-item"><div className="sum-item-v" style={{color:"#3dd6f5"}}>{fmtKm(totalBizKm)}</div><div className="sum-item-l">Business KM</div></div>
                  <div className="sum-item"><div className="sum-item-v" style={{color:"#f59e0b"}}>{fmt$(totalFuel)}</div><div className="sum-item-l">Total Fuel</div></div>
                  <div className="sum-item"><div className="sum-item-v" style={{color:"#a78bfa"}}>{personal.length}</div><div className="sum-item-l">Personal Drives</div></div>
                  <div className="sum-item"><div className="sum-item-v" style={{color:"#10b981"}}>$0.70/km</div><div className="sum-item-l">CRA Rate 2024</div></div>
                </div>
              </div>
              <button className="export-btn" onClick={() => exportCSV(trips)}>📥 Export CSV Report ({trips.length} drives)</button>
              <div className="section-title">Business Drives</div>
              {business.length===0 && <div className="empty"><div className="empty-icon">💼</div>No business drives yet.</div>}
              {business.map(t=>(
                <div key={t.id} className="trip-row">
                  <div className="trip-ico business">💼</div>
                  <div className="trip-info">
                    <div className="trip-route">{t.from} → {t.to}</div>
                    <div className="trip-meta">{t.date}{t.time?` · ${t.time}`:""} · {fmtKm(t.km)}</div>
                  </div>
                  <div className="trip-cost">
                    <div className="trip-cost-main">{fmt$(t.fuelCost)}</div>
                    <div className="trip-cost-cra">CRA {fmt$(t.craValue)}</div>
                  </div>
                </div>
              ))}
              <div style={{height:80}}/>
            </>
          )}
        </div>

        <div className="fab-area">
          <button className="fab-gps" onClick={() => setModal("gps")}>📍</button>
          <button className="fab" onClick={() => setModal("add")}>+</button>
        </div>

        {modal==="add" && <AddTripModal onAdd={addTrip} onClose={() => setModal(null)} fuelPrice={fuelPrice} vehicle={vehicle} workHours={workHours}/>}
        {modal==="gps" && <GPSModal onTrip={addTrip} onClose={() => setModal(null)} fuelPrice={fuelPrice} vehicle={vehicle} workHours={workHours}/>}
        {modal==="settings" && <SettingsModal vehicle={vehicle} setVehicle={handleVehicle} workHours={workHours} setWorkHours={setWorkHours} onClose={() => setModal(null)}/>}
      </div>
    </>
  );
}
