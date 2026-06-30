/* =========================================================
   CityRhythm — app.js
   - Geocoding + place data via OpenStreetMap (Nominatim + Overpass), no API key.
   - "Live busy" status is SIMULATED: a deterministic model based on
     place type, day of week, and hour, plus a per-place pseudo-random
     offset so two similar venues don't always show identical levels.
     This is clearly disclosed to the user — it is NOT a real-time feed.
   ========================================================= */

const state = {
  city: null,            // { name, lat, lon }
  userLoc: null,         // { lat, lon } if using device location
  category: 'poi',       // poi | food | drink
  places: { poi: [], food: [], drink: [] },
  loaded: { poi:false, food:false, drink:false },
  filters: {
    cuisine: new Set(),
    vibe: new Set(),
    poiType: new Set(),
    busy: new Set(),
    sort: 'distance'
  },
  activePlace: null
};

const CUISINES = ['Italian','Japanese','Local/Traditional','Seafood','Vegetarian','Steak & Grill','Café/Brunch','Street food','Indian','Mexican','Bakery'];
const VIBES = ['Chill', 'Lively', 'Live music', 'Rooftop', 'Late-night', 'Craft drinks', 'Dancing'];
const POI_TYPES = ['Landmark','Museum','Park','Viewpoint','Historic','Gallery','Market'];

// ---------- Tag mapping from OSM ----------
const CUISINE_KEYWORDS = {
  italian:'Italian', pizza:'Italian', japanese:'Japanese', sushi:'Japanese',
  seafood:'Seafood', vegetarian:'Vegetarian', vegan:'Vegetarian',
  steak_house:'Steak & Grill', grill:'Steak & Grill', cafe:'Café/Brunch',
  breakfast:'Café/Brunch', street_food:'Street food', indian:'Indian',
  mexican:'Mexican', bakery:'Bakery', regional:'Local/Traditional'
};

function init(){
  bindOnboard();
  bindMainUI();
  registerSW();
}
document.addEventListener('DOMContentLoaded', init);

/* ---------------- ONBOARD ---------------- */
function bindOnboard(){
  const form = document.getElementById('city-form');
  const input = document.getElementById('city-input');
  const suggestBox = document.getElementById('city-suggestions');
  let debounceTimer;

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if(q.length < 3){ suggestBox.hidden = true; return; }
    debounceTimer = setTimeout(() => searchCities(q, suggestBox, input), 350);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if(!q) return;
    setOnboardLoading(true);
    const result = await geocodeCity(q);
    setOnboardLoading(false);
    if(result){
      enterCity(result);
    } else {
      alert("Couldn't find that place. Try a more specific name, like \"Porto, Portugal\".");
    }
  });

  document.getElementById('use-location').addEventListener('click', () => {
    if(!navigator.geolocation){
      alert('Location is not available on this device/browser.');
      return;
    }
    setOnboardLoading(true, 'Finding you…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      state.userLoc = { lat: latitude, lon: longitude };
      const name = await reverseGeocode(latitude, longitude);
      setOnboardLoading(false);
      enterCity({ name: name || 'Current area', lat: latitude, lon: longitude });
    }, () => {
      setOnboardLoading(false);
      alert('Could not get your location. Please search for a city instead.');
    }, { timeout: 10000 });
  });
}

function setOnboardLoading(loading, label){
  const btn = document.querySelector('#city-form button[type="submit"] span');
  if(btn) btn.textContent = loading ? (label || 'Reading the room…') : 'Read the room';
}

async function searchCities(q, box, input){
  try{
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    if(!data.length){ box.hidden = true; return; }
    box.innerHTML = '';
    data.forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'suggestion-item';
      const main = item.display_name.split(',')[0];
      btn.innerHTML = `${main}<small>${item.display_name}</small>`;
      btn.addEventListener('click', () => {
        input.value = main;
        box.hidden = true;
        enterCity({ name: main, lat: parseFloat(item.lat), lon: parseFloat(item.lon) });
      });
      box.appendChild(btn);
    });
    box.hidden = false;
  }catch(err){
    box.hidden = true;
  }
}

async function geocodeCity(q){
  try{
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    if(!data.length) return null;
    return { name: q, lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  }catch(err){ return null; }
}

async function reverseGeocode(lat, lon){
  try{
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    return data?.address?.city || data?.address?.town || data?.address?.suburb || data?.display_name?.split(',')[0];
  }catch(err){ return null; }
}

function enterCity(cityObj){
  state.city = cityObj;
  document.getElementById('current-city-name').textContent = cityObj.name;
  document.getElementById('view-onboard').classList.remove('view--active');
  document.getElementById('view-main').classList.add('view--active');
  buildFilterChips();
  loadCategory('poi');
}

/* ---------------- MAIN UI ---------------- */
function bindMainUI(){
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
      tab.classList.add('tab--active');
      state.category = tab.dataset.cat;
      updateFilterVisibility();
      loadCategory(state.category);
    });
  });

  document.getElementById('change-city').addEventListener('click', () => {
    document.getElementById('view-main').classList.remove('view--active');
    document.getElementById('view-onboard').classList.add('view--active');
  });

  const filterToggle = document.getElementById('filter-toggle');
  const filterPanel = document.getElementById('filter-panel');
  filterToggle.addEventListener('click', () => {
    filterPanel.hidden = !filterPanel.hidden;
  });

  document.getElementById('clear-filters').addEventListener('click', () => {
    state.filters.cuisine.clear();
    state.filters.vibe.clear();
    state.filters.poiType.clear();
    state.filters.busy.clear();
    document.querySelectorAll('.chip[data-busy], .chip[data-cuisine], .chip[data-vibe], .chip[data-poitype]').forEach(c => c.classList.remove('chip--active'));
    updateFilterDot();
    renderList();
  });

  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  document.getElementById('sheet-backdrop').addEventListener('click', closeSheet);

  updateFilterVisibility();
}

function buildFilterChips(){
  buildChipGroup('chips-cuisine', CUISINES, 'cuisine');
  buildChipGroup('chips-vibe-drink', VIBES, 'vibe');
  buildChipGroup('chips-poi', POI_TYPES, 'poiType');

  document.querySelectorAll('#chips-busy .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const val = chip.dataset.busy;
      toggleSetVal(state.filters.busy, val);
      chip.classList.toggle('chip--active');
      updateFilterDot();
      renderList();
    });
  });

  document.querySelectorAll('#chips-sort .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#chips-sort .chip').forEach(c => c.classList.remove('chip--active'));
      chip.classList.add('chip--active');
      state.filters.sort = chip.dataset.sort;
      renderList();
    });
  });
}

function buildChipGroup(containerId, items, filterKey){
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  items.forEach(label => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = label;
    chip.dataset[filterKey] = label;
    chip.addEventListener('click', () => {
      toggleSetVal(state.filters[filterKey], label);
      chip.classList.toggle('chip--active');
      renderList();
    });
    container.appendChild(chip);
  });
}

function toggleSetVal(set, val){
  if(set.has(val)) set.delete(val); else set.add(val);
}

function updateFilterDot(){
  const any = state.filters.cuisine.size || state.filters.vibe.size || state.filters.poiType.size || state.filters.busy.size;
  document.getElementById('filter-dot').hidden = !any;
}

function updateFilterVisibility(){
  document.querySelectorAll('.filter-group[data-for]').forEach(group => {
    group.style.display = (group.dataset.for === state.category) ? '' : 'none';
  });
}

/* ---------------- DATA LOADING (Overpass) ---------------- */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

function categoryQuery(cat, lat, lon, radius=3000){
  if(cat === 'poi'){
    return `
      [out:json][timeout:25];
      (
        node["tourism"~"attraction|museum|gallery|viewpoint|artwork"](around:${radius},${lat},${lon});
        node["historic"](around:${radius},${lat},${lon});
        node["leisure"="park"](around:${radius},${lat},${lon});
        node["amenity"="marketplace"](around:${radius},${lat},${lon});
      );
      out body 60;
    `;
  }
  if(cat === 'food'){
    return `
      [out:json][timeout:25];
      (
        node["amenity"="restaurant"](around:${radius},${lat},${lon});
        node["amenity"="cafe"](around:${radius},${lat},${lon});
        node["amenity"="fast_food"](around:${radius},${lat},${lon});
      );
      out body 60;
    `;
  }
  // drink
  return `
    [out:json][timeout:25];
    (
      node["amenity"="bar"](around:${radius},${lat},${lon});
      node["amenity"="pub"](around:${radius},${lat},${lon});
      node["amenity"="nightclub"](around:${radius},${lat},${lon});
    );
    out body 60;
  `;
}

async function loadCategory(cat){
  renderLoading();
  if(state.loaded[cat]){ renderList(); return; }

  const { lat, lon } = state.city;
  const query = categoryQuery(cat, lat, lon);

  let data = null;
  for(const endpoint of OVERPASS_ENDPOINTS){
    try{
      const res = await fetch(endpoint, { method:'POST', body: 'data=' + encodeURIComponent(query) });
      if(!res.ok) continue;
      data = await res.json();
      break;
    }catch(err){ continue; }
  }

  if(!data){
    state.loaded[cat] = true;
    state.places[cat] = [];
    renderList(true);
    return;
  }

  const places = (data.elements || [])
    .filter(el => el.tags && el.tags.name)
    .map(el => buildPlace(el, cat));

  state.places[cat] = places;
  state.loaded[cat] = true;
  renderList();
}

function buildPlace(el, cat){
  const tags = el.tags;
  const dist = haversine(state.city.lat, state.city.lon, el.lat, el.lon);
  const cuisineTags = (tags.cuisine || '').split(';').map(c => c.trim().toLowerCase());
  const cuisineLabels = [...new Set(cuisineTags.map(c => CUISINE_KEYWORDS[c]).filter(Boolean))];
  const subtype = poiSubtype(tags);
  const vibe = inferVibe(tags, cat);
  const rating = pseudoRating(el.id);

  return {
    id: el.id,
    name: tags.name,
    lat: el.lat, lon: el.lon,
    distance: dist,
    category: cat,
    subtype,
    cuisines: cuisineLabels.length ? cuisineLabels : (cat === 'food' ? ['Local/Traditional'] : []),
    vibes: vibe,
    rating,
    address: formatAddress(tags),
    raw: tags
  };
}

function poiSubtype(tags){
  if(tags.tourism === 'museum') return 'Museum';
  if(tags.tourism === 'viewpoint') return 'Viewpoint';
  if(tags.tourism === 'gallery' || tags.tourism === 'artwork') return 'Gallery';
  if(tags.historic) return 'Historic';
  if(tags.leisure === 'park') return 'Park';
  if(tags.amenity === 'marketplace') return 'Market';
  if(tags.amenity === 'bar') return 'Bar';
  if(tags.amenity === 'pub') return 'Pub';
  if(tags.amenity === 'nightclub') return 'Club';
  if(tags.amenity === 'cafe') return 'Café';
  if(tags.amenity === 'fast_food') return 'Fast food';
  if(tags.amenity === 'restaurant') return 'Restaurant';
  return 'Landmark';
}

function inferVibe(tags, cat){
  const vibes = [];
  if(tags.amenity === 'nightclub') vibes.push('Dancing', 'Late-night');
  if(tags.amenity === 'pub') vibes.push('Chill');
  if(tags['rooftop'] === 'yes' || /roof/i.test(tags.name||'')) vibes.push('Rooftop');
  if(tags.live_music === 'yes') vibes.push('Live music');
  if(cat === 'drink' && !vibes.length) vibes.push(Math.random() > 0.5 ? 'Lively' : 'Chill');
  return [...new Set(vibes)];
}

function formatAddress(tags){
  const parts = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean);
  let line = parts.join(' ');
  if(tags['addr:suburb']) line += (line ? ', ' : '') + tags['addr:suburb'];
  return line || 'Address not listed — use navigation to find it';
}

/* ---------------- BUSY SIMULATION ENGINE ---------------- */
// Deterministic pseudo-random per place so it's stable within a session.
function seededRandom(seed){
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function pseudoRating(id){
  const r = 3.5 + seededRandom(id) * 1.5;
  return Math.round(r * 10) / 10;
}

// Returns busy level 0-1 and label for current time.
function getBusyLevel(place){
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0 sun .. 6 sat
  const isWeekend = day === 0 || day === 6 || day === 5;

  let curve;
  if(place.category === 'poi'){
    curve = poiCurve(hour);
  } else if(place.category === 'food'){
    curve = foodCurve(hour, place.subtype);
  } else {
    curve = drinkCurve(hour, isWeekend, place.subtype);
  }

  const personalOffset = (seededRandom(place.id) - 0.5) * 0.28;
  const level = Math.max(0.03, Math.min(1, curve + personalOffset));
  return level;
}

function poiCurve(hour){
  // open ~9-18, peak midday
  if(hour < 8 || hour > 19) return 0.05;
  const peak = 13;
  const dist = Math.abs(hour - peak);
  return Math.max(0.1, 0.85 - dist * 0.09);
}

function foodCurve(hour, subtype){
  if(subtype === 'Café'){
    if(hour >= 7 && hour <= 11) return 0.75 - Math.abs(hour-9)*0.1;
    if(hour >= 14 && hour <= 17) return 0.4;
    return 0.15;
  }
  // restaurants / fast food: lunch + dinner peaks
  const lunch = Math.max(0, 0.7 - Math.abs(hour-13)*0.25);
  const dinner = Math.max(0, 0.9 - Math.abs(hour-20)*0.2);
  return Math.max(0.08, lunch, dinner);
}

function drinkCurve(hour, isWeekend, subtype){
  let base;
  if(subtype === 'Club'){
    base = (hour >= 23 || hour <= 3) ? 0.9 : (hour >= 21 ? 0.5 : 0.05);
  } else {
    const evening = Math.max(0, 0.85 - Math.abs(hour-21)*0.15);
    const afternoon = (hour >= 16 && hour <= 19) ? 0.35 : 0;
    base = Math.max(0.08, evening, afternoon);
  }
  return isWeekend ? Math.min(1, base * 1.25) : base;
}

function busyLabel(level){
  if(level < 0.35) return 'quiet';
  if(level < 0.68) return 'moderate';
  return 'busy';
}

function busyStatusText(label, place){
  const map = {
    quiet: ['Quiet right now', 'Easy to get a spot'],
    moderate: ['Picking up', 'Some wait possible'],
    busy: ['Busy right now', place.category === 'drink' ? 'Expect a queue' : 'Expect a short wait']
  };
  return map[label];
}

/* Hourly shape for the detail sheet graph (12 bars across the day, 2hr steps) */
function hourlyShape(place){
  const bars = [];
  for(let h = 0; h < 24; h += 2){
    const fakeNow = new Date();
    fakeNow.setHours(h);
    const day = fakeNow.getDay();
    const isWeekend = day === 0 || day === 6 || day === 5;
    let v;
    if(place.category === 'poi') v = poiCurve(h);
    else if(place.category === 'food') v = foodCurve(h, place.subtype);
    else v = drinkCurve(h, isWeekend, place.subtype);
    const offset = (seededRandom(place.id + h) - 0.5) * 0.15;
    bars.push(Math.max(0.04, Math.min(1, v + offset)));
  }
  return bars;
}

/* ---------------- RENDER LIST ---------------- */
function renderLoading(){
  document.getElementById('list-status').hidden = false;
  document.getElementById('list-status').innerHTML = 'Loading places…';
  document.getElementById('list-items').innerHTML = '';
}

function applyFilters(places){
  let result = places.filter(p => {
    if(state.category === 'food' && state.filters.cuisine.size){
      if(!p.cuisines.some(c => state.filters.cuisine.has(c))) return false;
    }
    if(state.category === 'drink' && state.filters.vibe.size){
      if(!p.vibes.some(v => state.filters.vibe.has(v))) return false;
    }
    if(state.category === 'poi' && state.filters.poiType.size){
      if(!state.filters.poiType.has(p.subtype)) return false;
    }
    if(state.filters.busy.size){
      const label = busyLabel(getBusyLevel(p));
      if(!state.filters.busy.has(label)) return false;
    }
    return true;
  });

  if(state.filters.sort === 'distance'){
    result.sort((a,b) => a.distance - b.distance);
  } else if(state.filters.sort === 'rating'){
    result.sort((a,b) => b.rating - a.rating);
  } else if(state.filters.sort === 'quiet'){
    result.sort((a,b) => getBusyLevel(a) - getBusyLevel(b));
  }
  return result;
}

function renderList(failed){
  const listStatus = document.getElementById('list-status');
  const listItems = document.getElementById('list-items');
  const all = state.places[state.category] || [];

  if(failed){
    listStatus.hidden = false;
    listStatus.innerHTML = `<strong>Couldn't load places</strong>Check your connection and try switching tabs again.`;
    listItems.innerHTML = '';
    return;
  }

  const filtered = applyFilters(all);

  if(!filtered.length){
    listStatus.hidden = false;
    listStatus.innerHTML = all.length
      ? `<strong>Nothing matches those filters</strong>Try clearing a filter or two.`
      : `<strong>No places found nearby</strong>Try a different city or area.`;
    listItems.innerHTML = '';
    return;
  }

  listStatus.hidden = true;
  listItems.innerHTML = '';
  filtered.forEach(place => listItems.appendChild(renderCard(place)));
}

function renderCard(place){
  const level = getBusyLevel(place);
  const label = busyLabel(level);
  const card = document.createElement('button');
  card.className = 'card';
  card.addEventListener('click', () => openSheet(place));

  const metaParts = [];
  if(place.category === 'poi') metaParts.push(place.subtype);
  if(place.category === 'food') metaParts.push(place.cuisines[0] || place.subtype);
  if(place.category === 'drink') metaParts.push(place.subtype, ...place.vibes.slice(0,1));
  metaParts.push(`★ ${place.rating}`);

  card.innerHTML = `
    <div class="card__pulse card__pulse--${label}">${pulseIcon(label)}</div>
    <div class="card__body">
      <div class="card__top">
        <span class="card__name">${escapeHtml(place.name)}</span>
        <span class="card__dist">${formatDistance(place.distance)}</span>
      </div>
      <div class="card__meta">${metaParts.filter(Boolean).map(m => `<span>${escapeHtml(m)}</span>`).join('<span class="card__dot"></span>')}</div>
      <div class="card__status-row">
        <div class="status-bars status-bars--${label}"><span></span><span></span><span></span></div>
        <span class="status-label status-label--${label}">${busyStatusText(label, place)[0]}</span>
      </div>
    </div>
  `;
  return card;
}

function pulseIcon(label){
  const color = 'currentColor';
  return `<svg viewBox="0 0 24 24" fill="none"><polyline points="2,12 7,12 9,5 13,19 16,12 22,12" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function formatDistance(meters){
  if(meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters/1000).toFixed(1)} km`;
}

function haversine(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ---------------- DETAIL SHEET ---------------- */
function openSheet(place){
  state.activePlace = place;
  const level = getBusyLevel(place);
  const label = busyLabel(level);
  const statusText = busyStatusText(label, place);
  const bars = hourlyShape(place);
  const nowIdx = Math.floor(new Date().getHours()/2);

  const tagsHtml = [...place.cuisines, ...place.vibes, place.subtype]
    .filter(Boolean)
    .map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');

  const hourLabels = ['12am','4am','8am','12pm','4pm','8pm'];

  document.getElementById('sheet-content').innerHTML = `
    <h2 class="sheet__name">${escapeHtml(place.name)}</h2>
    <p class="sheet__meta">${escapeHtml(place.subtype)} · ${formatDistance(place.distance)} away · ★ ${place.rating}</p>

    <div class="sheet__status sheet__status--${label}">
      <svg class="sheet__status-icon" viewBox="0 0 24 24" fill="none" style="color:var(--${label === 'busy' ? 'busy' : label})"><polyline points="2,12 7,12 9,5 13,19 16,12 22,12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div class="sheet__status-text">
        <strong style="color:var(--${label === 'busy' ? 'busy' : label})">${statusText[0]}</strong>
        <span>${statusText[1]} · estimated for ${new Date().toLocaleDateString(undefined,{weekday:'long'})}s around this hour</span>
      </div>
    </div>

    <div class="sheet__hours-graph">
      <p class="sheet__section-title">Typical pattern today</p>
      <div class="hours-bars">
        ${bars.map((v,i) => `<div class="hbar ${i===nowIdx?'hbar--now':''}" style="height:${Math.max(8, v*64)}px"></div>`).join('')}
      </div>
      <div class="hours-labels">${hourLabels.map(h => `<span>${h}</span>`).join('')}</div>
    </div>

    <div class="sheet__tags">${tagsHtml}</div>

    <div class="sheet__actions">
      <button class="btn btn--nav" id="nav-btn">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M3 11l18-8-8 18-2-8-8-2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        Navigate
      </button>
      <button class="btn btn--secondary" id="share-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4-4 4M12 2v14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Share
      </button>
    </div>

    <p class="sheet__address">${escapeHtml(place.address)}</p>
  `;

  document.getElementById('nav-btn').addEventListener('click', () => navigateTo(place));
  document.getElementById('share-btn').addEventListener('click', () => sharePlace(place));

  document.getElementById('sheet-backdrop').hidden = false;
  document.getElementById('detail-sheet').hidden = false;
}

function closeSheet(){
  document.getElementById('sheet-backdrop').hidden = true;
  document.getElementById('detail-sheet').hidden = true;
}

function navigateTo(place){
  // Hands off to the device's map app for actual turn-by-turn directions.
  const url = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lon}&travelmode=walking`;
  window.open(url, '_blank');
}

function sharePlace(place){
  const url = `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lon}`;
  if(navigator.share){
    navigator.share({ title: place.name, text: `Check out ${place.name}`, url }).catch(()=>{});
  } else {
    navigator.clipboard?.writeText(url);
    alert('Link copied to clipboard.');
  }
}

/* ---------------- PWA ---------------- */
function registerSW(){
  if('serviceWorker' in navigator){
    // Use a path relative to the current document's directory, resolved explicitly,
    // so this works correctly whether the app sits at a domain root or in a subfolder
    // (e.g. GitHub Pages project sites like /CityRythmnsNew/).
    const swUrl = new URL('sw.js', document.baseURI).href;
    navigator.serviceWorker.register(swUrl, { scope: './' })
      .then(reg => {
        console.log('SW registered with scope:', reg.scope);
        showDebugBanner('Service worker registered \u2713', false);
      })
      .catch(err => {
        console.error('SW registration failed:', err);
        showDebugBanner('Service worker FAILED: ' + err.message, true);
      });
  } else {
    showDebugBanner('Service workers not supported in this browser', true);
  }
}

// Temporary on-screen debug banner -- safe to remove once install works reliably.
function showDebugBanner(msg, isError){
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.bottom = '0';
  el.style.left = '0';
  el.style.right = '0';
  el.style.zIndex = '9999';
  el.style.padding = '10px 14px';
  el.style.fontSize = '12px';
  el.style.fontFamily = 'monospace';
  el.style.color = '#fff';
  el.style.background = isError ? '#7a1f1f' : '#1f4d2e';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}
