'use strict';

// URL du Worker Cloudflare zamble-search-api (recherche eBay).
// L'origine de cette appli doit être ajoutée à la liste blanche CORS du Worker
// (src/index.ts) avant que les appels ci-dessous fonctionnent en production.
const SEARCH_API_URL = 'https://zamble-search-api.zamble.workers.dev';

const STORAGE_KEY = 'zamble-scan-items';

// Identifiants d'affiliation déjà actifs (mêmes comptes que zamble-comparatifs) —
// ce ne sont pas des secrets, un tag affilié est public par nature dans un lien.
const AMAZON_ASSOCIATE_TAG = 'bonsplanszamble-21';

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

let items = loadItems();
let sequentialQueue = null; // { ids: [...], index: 0 } quand le mode "un par un" est actif

function detectTypeFromCode(code) {
  // Les ISBN (livres) sont des EAN-13 avec le préfixe Bookland 978/979 —
  // règle fiable, aucun jeu/objet ne l'utilise. Sert uniquement à décider si
  // on tente l'auto-remplissage via Open Library/Google Books en arrière-plan,
  // l'appli n'a plus de filtre livre/jeu visible (généraliste depuis peu).
  return code.startsWith('978') || code.startsWith('979') ? 'livre' : 'objet';
}

// ---------------------------------------------------------------------------
// Persistance locale
// ---------------------------------------------------------------------------

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveItems() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (e) {
    showToast("Impossible d'enregistrer la liste (stockage plein ?).", true);
  }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.style.display = 'block';
  clearTimeout(toastTimer);
  // Les erreurs restent affichées plus longtemps (besoin de pouvoir les lire/relayer),
  // les messages de confirmation classiques restent brefs.
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, isError ? 9000 : 3200);
}

// ---------------------------------------------------------------------------
// Lookup ISBN — repris de l'ancien zamble.fr (Open Library puis Google Books)
// ---------------------------------------------------------------------------

async function lookupOpenLibrary(isbn) {
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await r.json();
    const key = `ISBN:${isbn}`;
    if (!data[key]) return null;
    const book = data[key];
    return {
      title: book.title || null,
      author: book.authors?.[0]?.name || null,
      cover: book.cover?.large || book.cover?.medium || null
    };
  } catch { return null; }
}

async function lookupGoogleBooks(isbn) {
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await r.json();
    if (!data.items || data.items.length === 0) return null;
    const info = data.items[0].volumeInfo;
    const cover = (info.imageLinks?.extraLarge || info.imageLinks?.large ||
                   info.imageLinks?.medium || info.imageLinks?.thumbnail || null)
      ?.replace('http://', 'https://');
    return {
      title: info.title || null,
      author: info.authors?.[0] || null,
      cover: cover || null
    };
  } catch { return null; }
}

async function lookupISBN(isbn) {
  const fromOL = await lookupOpenLibrary(isbn);
  if (fromOL?.title) return fromOL;
  const fromGB = await lookupGoogleBooks(isbn);
  if (fromGB?.title) return fromGB;
  return null;
}

// ---------------------------------------------------------------------------
// Enrichissement prix eBay (best-effort, silencieux si échec) via zamble-search-api
// ---------------------------------------------------------------------------

async function enrichEbayPrice(item) {
  if (!item.title) return;
  item.priceStatus = 'pending';
  render();
  try {
    const r = await fetch(`${SEARCH_API_URL}/search?q=${encodeURIComponent(item.title)}`, {
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) throw new Error('bad status');
    const data = await r.json();
    // On ignore le flag global `data.mock` : il est vrai dès qu'UNE des deux
    // sources est mockée (Amazon l'est en permanence) — on se fie plutôt au
    // flag par annonce, qui distingue vraiment les résultats eBay réels.
    const ebayResults = (data.results || []).filter((x) => x.source === 'ebay' && !x.mock);
    if (ebayResults.length > 0) {
      const cheapest = ebayResults.reduce((a, b) => (a.price < b.price ? a : b));
      item.priceStatus = 'found';
      item.ebayPrice = cheapest.price;
      // affiliateUrl (déjà tagué avec le Campaign ID EPN côté Worker) plutôt
      // que url brute — rémunéré, sans rien à reconfigurer.
      item.ebayUrl = cheapest.affiliateUrl || cheapest.url;
    } else {
      item.priceStatus = 'none';
    }
  } catch {
    item.priceStatus = 'none';
  }
  saveItems();
  render();
}

function retryPendingEnrichment() {
  items.filter((it) => it.title && it.priceStatus !== 'found').forEach(enrichEbayPrice);
}
window.addEventListener('online', retryPendingEnrichment);

// ---------------------------------------------------------------------------
// Construction des liens
// ---------------------------------------------------------------------------

function buildGoogleUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
function buildAmazonUrl(query) {
  // Tag affilié valable aussi sur une recherche (pas besoin d'un ASIN précis) —
  // rémunéré si un achat suit dans la fenêtre de cookie Amazon.
  return `https://www.amazon.fr/s?k=${encodeURIComponent(query)}&tag=${AMAZON_ASSOCIATE_TAG}`;
}
function buildVintedUrl(query) {
  return `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}`;
}
function buildEtsyUrl(query) {
  // Recherche simple, sans tag d'affiliation (pas de compte Etsy/Awin configuré).
  return `https://www.etsy.com/fr/search?q=${encodeURIComponent(query)}`;
}

// Recherches Google orientées par mot-clé — évite d'avoir besoin d'identifier
// précisément l'objet : Google fait le travail à partir du code brut ou du
// titre déjà connu.
const SEARCH_FILTERS = [
  { label: 'Prix neuf', suffix: 'prix neuf' },
  { label: 'Prix occasion', suffix: 'prix occasion' },
  { label: 'Avis', suffix: 'avis test' },
  { label: 'Comparatif', suffix: 'comparatif' },
  { label: 'Notice', suffix: 'notice manuel pdf' }
];

function buildFilteredSearchUrl(query, suffix) {
  return buildGoogleUrl(`${query} ${suffix}`);
}

// ---------------------------------------------------------------------------
// Gestion des objets
// ---------------------------------------------------------------------------

function createAndQueueItem({ type, code, title, cover }) {
  const item = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    type,
    code,
    title,
    author: null,
    cover: cover || null,
    priceStatus: null,
    ebayPrice: null,
    ebayUrl: null,
    createdAt: Date.now()
  };
  items.unshift(item);
  saveItems();
  render();
  return item;
}

function addItem(type, code) {
  const item = createAndQueueItem({ type, code, title: code });

  if (type === 'livre') {
    identifyBook(item);
  } else {
    showToast('Code enregistré — renommez le titre si besoin 📦');
    enrichEbayPrice(item);
  }
}

async function identifyBook(item) {
  showToast('Recherche du livre... 📚');
  const found = await lookupISBN(item.code);
  const current = items.find((i) => i.id === item.id);
  if (!current) return; // supprimé entre-temps
  if (found?.title) {
    current.title = found.title;
    current.author = found.author;
    current.cover = found.cover;
    showToast('Livre trouvé ! ✨');
  } else {
    showToast('Livre non trouvé — renommez le titre manuellement.', true);
  }
  saveItems();
  render();
  enrichEbayPrice(current);
}

function removeItem(id) {
  items = items.filter((i) => i.id !== id);
  saveItems();
  render();
}

function clearAllItems() {
  if (items.length === 0) return;
  if (!confirm(`Vider toute la liste ? ${items.length} objet(s) seront supprimés.`)) return;
  items = [];
  saveItems();
  render();
}

function renameItem(id, newTitle) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  const trimmed = newTitle.trim();
  if (!trimmed || trimmed === item.title) return;
  item.title = trimmed;
  item.priceStatus = null;
  saveItems();
  enrichEbayPrice(item);
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function render() {
  const list = document.getElementById('item-list');
  const empty = document.getElementById('empty-state');
  const countBadge = document.getElementById('item-count');

  countBadge.textContent = items.length;
  empty.style.display = items.length === 0 ? 'block' : 'none';

  list.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'item-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'item-select';
    checkbox.dataset.id = item.id;
    checkbox.addEventListener('change', updateBatchButtonsState);
    li.appendChild(checkbox);

    if (item.cover) {
      const img = document.createElement('img');
      img.className = 'item-cover';
      img.src = item.cover;
      img.alt = '';
      li.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'item-body';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'item-title';
    titleInput.value = item.title;
    titleInput.addEventListener('change', (e) => renameItem(item.id, e.target.value));
    body.appendChild(titleInput);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = (item.type === 'livre' ? '📚' : '📦') +
      (item.author ? ` ${item.author}` : '') + ` · ${item.code}`;
    body.appendChild(meta);

    const price = document.createElement('div');
    if (item.priceStatus === 'pending') {
      price.className = 'item-price pending';
      price.textContent = 'Recherche du prix eBay...';
    } else if (item.priceStatus === 'found') {
      price.className = 'item-price found';
      price.textContent = `dès ${item.ebayPrice} € sur eBay`;
    } else {
      price.className = 'item-price pending';
      price.textContent = 'Prix eBay non trouvé';
    }
    body.appendChild(price);

    const links = document.createElement('div');
    links.className = 'item-links';
    links.appendChild(makeLinkBtn('Google', buildGoogleUrl(item.title)));
    links.appendChild(makeLinkBtn('Amazon', buildAmazonUrl(item.title)));
    links.appendChild(makeLinkBtn('Vinted', buildVintedUrl(item.title)));
    links.appendChild(makeLinkBtn('Etsy', buildEtsyUrl(item.title)));
    if (item.ebayUrl) links.appendChild(makeLinkBtn('eBay', item.ebayUrl));
    body.appendChild(links);

    const filterLinks = document.createElement('div');
    filterLinks.className = 'item-links item-filter-links';
    for (const f of SEARCH_FILTERS) {
      filterLinks.appendChild(makeLinkBtn(f.label, buildFilteredSearchUrl(item.title, f.suffix)));
    }
    body.appendChild(filterLinks);

    li.appendChild(body);

    const delBtn = document.createElement('button');
    delBtn.className = 'item-delete';
    delBtn.textContent = '🗑';
    delBtn.title = 'Supprimer';
    delBtn.addEventListener('click', () => removeItem(item.id));
    li.appendChild(delBtn);

    list.appendChild(li);
  }
  updateBatchButtonsState();
}

function makeLinkBtn(label, url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = label;
  return a;
}

function getSelectedIds() {
  return Array.from(document.querySelectorAll('.item-select:checked')).map((c) => c.dataset.id);
}

function updateBatchButtonsState() {
  const n = getSelectedIds().length;
  document.getElementById('open-selected-btn').disabled = n === 0;
  const selectAll = document.getElementById('select-all');
  selectAll.checked = n > 0 && n === items.length;
}

// ---------------------------------------------------------------------------
// Ouverture des liens sélectionnés (Google, lien principal de chaque objet)
// ---------------------------------------------------------------------------
// Les navigateurs mobiles bloquent l'ouverture de plusieurs onglets à la fois
// depuis un seul geste (confirmé sur téléphone réel) — un seul flux séquentiel
// ("ouvrir le suivant", un tap par objet) plutôt que deux modes dont un cassé.

function startSequentialOpen() {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  sequentialQueue = { ids, index: 0 };
  updateSequentialUI();
}

function openNextSequential() {
  if (!sequentialQueue) return;
  const { ids, index } = sequentialQueue;
  if (index >= ids.length) {
    sequentialQueue = null;
    updateSequentialUI();
    return;
  }
  const item = items.find((it) => it.id === ids[index]);
  if (item) window.open(buildGoogleUrl(item.title), '_blank');
  sequentialQueue.index++;
  updateSequentialUI();
}

function updateSequentialUI() {
  const el = document.getElementById('sequential-status');
  if (!sequentialQueue) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const { ids, index } = sequentialQueue;
  el.style.display = 'block';
  if (index >= ids.length) {
    el.textContent = 'Terminé — tous les liens ont été ouverts.';
    return;
  }
  el.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = `Objet ${index + 1} / ${ids.length} — `;
  el.appendChild(label);
  const btn = document.createElement('button');
  btn.textContent = 'Ouvrir le suivant';
  btn.addEventListener('click', openNextSequential);
  el.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Scanner code-barre — repris de l'ancien zamble.fr
// ---------------------------------------------------------------------------

let scannerStream = null;
let scannerInterval = null;

async function startBarcodeScanner() {
  const wrap = document.getElementById('scanner-wrap');
  const video = document.getElementById('scanner-video');
  const status = document.getElementById('scanner-status');

  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('Caméra non disponible sur cet appareil.', true);
    return;
  }

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = scannerStream;
    wrap.style.display = 'flex';
    status.textContent = 'Pointez vers le code-barre...';

    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({
        // qr_code en plus des codes-barres 1D classiques : de plus en plus de
        // produits l'utilisent à la place d'un EAN.
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code']
      });
      scannerInterval = setInterval(async () => {
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) onBarcodeDetected(barcodes[0].rawValue);
        } catch { /* frame illisible, on continue */ }
      }, 400);
    } else {
      status.textContent = 'Chargement du scanner...';
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.19.1/umd/index.min.js';
      script.onload = () => {
        status.textContent = 'Pointez vers le code-barre...';
        const codeReader = new ZXing.BrowserMultiFormatReader();
        codeReader.decodeFromVideoElement(video, (result) => {
          if (result) onBarcodeDetected(result.getText());
        });
        window._zxingReader = codeReader;
      };
      script.onerror = () => {
        showToast('Le scanner de secours (ZXing) n\'a pas pu être chargé — vérifiez la connexion.', true);
      };
      document.head.appendChild(script);
    }
  } catch (err) {
    // On affiche le nom/message réel de l'erreur (ex. NotAllowedError,
    // NotReadableError, NotFoundError) plutôt qu'un message générique — sinon
    // impossible de distinguer un refus de permission d'un problème matériel.
    const detail = err && (err.name || err.message) ? `${err.name || ''} ${err.message || ''}`.trim() : 'erreur inconnue';
    showToast(`Caméra inaccessible : ${detail}`, true);
    console.error('startBarcodeScanner:', err);
    wrap.style.display = 'none';
  }
}

function onBarcodeDetected(code) {
  stopBarcodeScanner();
  showToast('Code détecté : ' + code + ' ✨');
  addItem(detectTypeFromCode(code), code);
}

function stopBarcodeScanner() {
  if (scannerStream) { scannerStream.getTracks().forEach((t) => t.stop()); scannerStream = null; }
  if (scannerInterval) { clearInterval(scannerInterval); scannerInterval = null; }
  if (window._zxingReader) { window._zxingReader.reset(); window._zxingReader = null; }
  document.getElementById('scanner-wrap').style.display = 'none';
}

// ---------------------------------------------------------------------------
// Ajout manuel (sans scanner)
// ---------------------------------------------------------------------------

function manualAdd() {
  const title = prompt('Titre ou description de l\'objet :');
  if (!title || !title.trim()) return;
  const item = createAndQueueItem({ type: 'objet', code: '(saisie manuelle)', title: title.trim() });
  enrichEbayPrice(item);
}

// ---------------------------------------------------------------------------
// Câblage des événements UI
// ---------------------------------------------------------------------------

function initUI() {
  document.getElementById('scan-btn').addEventListener('click', startBarcodeScanner);
  document.getElementById('scanner-close-btn').addEventListener('click', stopBarcodeScanner);
  document.getElementById('manual-add-btn').addEventListener('click', manualAdd);

  document.getElementById('select-all').addEventListener('change', (e) => {
    document.querySelectorAll('.item-select').forEach((c) => { c.checked = e.target.checked; });
    updateBatchButtonsState();
  });
  document.getElementById('open-selected-btn').addEventListener('click', startSequentialOpen);
  document.getElementById('clear-all-btn').addEventListener('click', clearAllItems);

  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', initUI);
