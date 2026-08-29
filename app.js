'use strict';

// URL du Worker Cloudflare zamble-search-api (recherche eBay).
// L'origine de cette appli doit être ajoutée à la liste blanche CORS du Worker
// (src/index.ts) avant que les appels ci-dessous fonctionnent en production.
const SEARCH_API_URL = 'https://zamble-search-api.zamble.workers.dev';

const STORAGE_KEY = 'zamble-scan-items';

// Identifiants d'affiliation déjà actifs (mêmes comptes que zamble-comparatifs) —
// ce ne sont pas des secrets, un tag affilié est public par nature dans un lien.
const AMAZON_ASSOCIATE_TAG = 'bonsplanszamble-21';

// Message unique quel que soit le service externe qui a atteint sa limite
// (Vision, Google Books, UPCitemdb...) — même texte que côté Worker
// (src/index.ts, FREE_QUOTA_MESSAGE) : tout reste gratuit tant qu'aucune
// limite n'est touchée, et le jour où l'une l'est, même message partout.
const FREE_QUOTA_MESSAGE =
  "Vous avez atteint le nombre de requêtes maximal pour un usage en mode gratuit. Pour repousser cette limite, abonnez-vous à l'option de votre choix.";

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

let items = loadItems();
let sequentialQueue = null; // { ids: [...], index: 0 } quand le mode "un par un" est actif
let adTemplates = loadAdTemplates();

function detectTypeFromCode(code) {
  // Les ISBN (livres) sont des EAN-13 avec le préfixe Bookland 978/979 —
  // règle fiable, aucun jeu/objet ne l'utilise. Sert uniquement à décider si
  // on tente l'auto-remplissage via Open Library/Google Books en arrière-plan,
  // l'appli n'a plus de filtre livre/jeu visible (généraliste depuis peu).
  return code.startsWith('978') || code.startsWith('979') ? 'livre' : 'objet';
}

function isUrl(code) {
  // Un QR code encode le plus souvent une URL plutôt qu'un identifiant produit
  // lisible — sert à distinguer ce cas pour proposer un lien direct et inviter
  // à renommer le titre (chercher l'URL brute sur Google ne donne rien d'utile).
  return /^https?:\/\//i.test(code);
}

// Mots de navigation/marketing qui reviennent sur beaucoup de sites et ne
// désignent jamais un produit — liste volontairement courte (pas la peine
// de la faire grossir au coup par coup, ça ne couvrira jamais tous les cas).
const URL_TITLE_STOPWORDS = new Set([
  'qrcode', 'qr', 'www', 'index', 'redirect', 'landing', 'campaign',
  'promo', 'page', 'product', 'category', 'item', 'ref', 'utm', 'wheel'
]);

function guessTitleFromUrl(rawUrl) {
  // Heuristique, pas une extraction fiable : certains QR codes ne pointent
  // même pas vers une fiche produit (ex. page marketing type "roue de la
  // fortune") — il n'y a alors aucun nom de produit à retrouver dans l'URL,
  // et le nom de domaine (souvent la marque) reste le seul signal fiable.
  try {
    const u = new URL(rawUrl);
    // Certaines marques utilisent un sous-domaine dédié aux QR codes
    // (ex. "qrcode.marque.fr") — on saute ces labels génériques plutôt que de
    // prendre bêtement le premier, sinon la marque elle-même est perdue.
    const hostLabels = u.hostname.split('.');
    const brand = hostLabels.find((l) => !['www', 'qr', 'qrcode'].includes(l.toLowerCase())) || hostLabels[0];
    const pathWords = u.pathname
      .split('/')
      .filter((seg) => seg && !/^\d+$/.test(seg))
      .flatMap((seg) => seg.replace(/[-_+]/g, ' ').split(' '))
      // Mots de 1-2 lettres (codes pays/langue, fragments de route) et mots
      // de navigation génériques : jamais un nom de produit.
      .filter((word) => word.length >= 3 && !URL_TITLE_STOPWORDS.has(word.toLowerCase()));

    // Dédoublonnage (insensible à la casse) : une marque répétée dans le
    // chemin (sous-domaine + slug identique) ne doit apparaître qu'une fois.
    const seen = new Set();
    const words = [brand, ...pathWords].filter((w) => {
      const key = w.toLowerCase();
      if (!w || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return words.join(' ').trim();
  } catch {
    return rawUrl;
  }
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

const AD_TEMPLATES_STORAGE_KEY = 'zamble-scan-ad-templates';

function loadAdTemplates() {
  try {
    const raw = localStorage.getItem(AD_TEMPLATES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAdTemplates() {
  try {
    localStorage.setItem(AD_TEMPLATES_STORAGE_KEY, JSON.stringify(adTemplates));
  } catch {
    showToast("Impossible d'enregistrer le modèle (stockage plein ?).", true);
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
      author: (book.authors || []).map((a) => a.name).filter(Boolean).join(', ') || null,
      publisher: book.publishers?.[0]?.name || null,
      cover: book.cover?.large || book.cover?.medium || null
    };
  } catch { return null; }
}

// Passe par le Worker (clé Google Books dédiée) plutôt qu'un appel direct :
// l'API Google Books appelée sans clé depuis le navigateur partage un quota
// anonyme mondial qui se retrouve régulièrement à sec (constaté en prod),
// laissant le code brut affiché comme titre faute de résultat.
async function lookupGoogleBooks(isbn) {
  try {
    const r = await fetch(`${SEARCH_API_URL}/book-lookup?isbn=${encodeURIComponent(isbn)}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.quotaExceeded) return { quotaExceeded: true };
    return data.title ? data : null;
  } catch { return null; }
}

async function lookupISBN(isbn) {
  const fromOL = await lookupOpenLibrary(isbn);
  if (fromOL?.title) return fromOL;
  const fromGB = await lookupGoogleBooks(isbn);
  if (fromGB?.quotaExceeded) return { quotaExceeded: true };
  if (fromGB?.title) return fromGB;
  return null;
}

// ---------------------------------------------------------------------------
// Lookup code-barres générique (jeux, jouets...) via zamble-search-api
// (UPCitemdb) — équivalent de lookupISBN pour tout ce qui n'est pas un livre.
// ---------------------------------------------------------------------------

async function lookupProduct(code) {
  try {
    const r = await fetch(`${SEARCH_API_URL}/product-lookup?upc=${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.quotaExceeded) return { quotaExceeded: true };
    return { title: data.title || null, brand: data.brand || null };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Enrichissement prix eBay (best-effort, silencieux si échec) via zamble-search-api
// ---------------------------------------------------------------------------

// Mots indiquant une extension/un accessoire plutôt que le jeu/objet de base
// — un tri eBay par prix pur les fait remonter avant l'article complet, ce
// qui rend le "moins cher" trouvé trompeur (constaté en conditions réelles :
// un "Monster Pack" à 12,46 € passait devant le jeu de base King of Tokyo à
// 14,99 €, alors que l'utilisateur cherchait bien le jeu complet). Liste
// courte et non exhaustive, comme SEARCH_NOISE_WORDS — ne couvrira jamais
// tous les cas, à ajuster si un nouveau cas réel le montre insuffisant.
const EBAY_ACCESSORY_WORDS = ['extension', 'expansion', 'pack', 'accessoire', 'accessory', 'promo', 'goodies'];

function looksLikeAccessory(title) {
  const normalized = title.toLowerCase();
  return EBAY_ACCESSORY_WORDS.some((word) => normalized.includes(word));
}

async function enrichEbayPrice(item) {
  if (!item.title) return;
  item.priceStatus = 'pending';
  render();
  try {
    const r = await fetch(`${SEARCH_API_URL}/search?q=${encodeURIComponent(buildStrictSearchQuery(item))}`, {
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) throw new Error('bad status');
    const data = await r.json();
    // On ignore le flag global `data.mock` : il est vrai dès qu'UNE des deux
    // sources est mockée (Amazon l'est en permanence) — on se fie plutôt au
    // flag par annonce, qui distingue vraiment les résultats eBay réels.
    const ebayResults = (data.results || []).filter((x) => x.source === 'ebay' && !x.mock);
    // On écarte les extensions/accessoires du choix du "moins cher" — sauf si
    // TOUS les résultats en ont l'air (mieux vaut un prix imparfait qu'aucun).
    const genuineResults = ebayResults.filter((x) => !looksLikeAccessory(x.title));
    const candidates = genuineResults.length > 0 ? genuineResults : ebayResults;
    if (candidates.length > 0) {
      const cheapest = candidates.reduce((a, b) => (a.price < b.price ? a : b));
      item.priceStatus = 'found';
      item.ebayPrice = cheapest.price;
      // affiliateUrl (déjà tagué avec le Campaign ID EPN côté Worker) plutôt
      // que url brute — rémunéré, sans rien à reconfigurer. Sert uniquement à
      // rendre le badge de prix cliquable vers CETTE annonce précise ; le
      // bouton "eBay" à côté reste une recherche classique (plus sûre en cas
      // de mauvais match, voir plus haut).
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
// Campaign ID EPN déjà approuvé (voir zamble-comparatifs) — même principe que
// le tag Amazon juste en dessous, appliqué directement sur l'URL de
// recherche plutôt que sur une annonce précise (voir buildEbayUrl : le badge
// de prix reste informatif, mais le lien cliquable est désormais une
// recherche comme les autres, pas l'annonce trouvée — demandé par
// l'utilisateur après un risque de mauvais match constaté).
const EBAY_CAMPAIGN_ID = '5339192002';

function buildAmazonUrl(query) {
  // Tag affilié valable aussi sur une recherche (pas besoin d'un ASIN précis) —
  // rémunéré si un achat suit dans la fenêtre de cookie Amazon.
  return `https://www.amazon.fr/s?k=${encodeURIComponent(query)}&tag=${AMAZON_ASSOCIATE_TAG}`;
}
function buildVintedUrl(query) {
  return `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}`;
}

// Mots trop rares/spécifiques au catalogue pour aider la recherche (mention de
// langue, "version") — testé en conditions réelles sur l'API eBay : chaque mot
// pris seul ne gêne pas beaucoup, mais leur combinaison ("French version")
// fait tomber le nombre de résultats à zéro alors que la requête sans eux en
// retrouve 4. Comparaison insensible aux accents/majuscules.
const SEARCH_NOISE_WORDS = new Set([
  'version', 'french', 'francais', 'francaise', 'anglais', 'anglaise', 'english',
  'allemand', 'allemande', 'german', 'italien', 'italienne', 'italian',
  'espagnol', 'espagnole', 'spanish', 'neerlandais', 'portugais', 'portugaise',
  'portuguese', 'multilingue', 'multilingual'
]);

function stripNoiseWords(text) {
  return text
    .split(/\s+/)
    .filter((tok) => {
      const normalized = tok.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
      return !SEARCH_NOISE_WORDS.has(normalized);
    })
    .join(' ')
    .trim();
}

// Requête stricte pour Vinted, eBay ET Amazon : uniquement le titre du
// jeu/objet + l'éditeur, sans numéro de référence catalogue ni mention de
// langue/version. Utilisée d'abord pour Vinted (demandé explicitement, la
// requête complète n'y retrouvait rien), étendue à eBay puis à Amazon après
// des cas réels similaires constatés à chaque fois : un numéro de référence
// catalogue isolé (ex. "51315") peut à lui seul faire disparaître une
// annonce bien réelle des résultats — un test en direct sur l'API eBay a
// montré qu'une annonce à 20 € trouvée manuellement par l'utilisateur
// (« Jeux de société - King of Tokyo ») n'apparaissait qu'une fois ce numéro
// retiré de la requête, et le même symptôme a été observé sur Amazon.
// Réservé aux objets génériques : un livre peut légitimement avoir un nombre
// dans son titre ("1984", "80 jours"), on ne veut pas y toucher (garde
// `buildSearchQuery`, la requête complète, pour Google/Etsy et les livres).
function buildStrictSearchQuery(item) {
  if (item.type === 'livre') return buildSearchQuery(item);
  const parts = [item.title];
  if (item.publisher) parts.push(item.publisher);
  const withoutNumbers = parts.join(' ').split(/\s+/).filter((tok) => !/^\d+$/.test(tok)).join(' ');
  return stripNoiseWords(withoutNumbers) || buildSearchQuery(item);
}
function buildEtsyUrl(query) {
  // Recherche simple, sans tag d'affiliation (pas de compte Etsy/Awin configuré).
  return `https://www.etsy.com/fr/search?q=${encodeURIComponent(query)}`;
}
function buildEbayUrl(query) {
  const url = new URL('https://www.ebay.fr/sch/i.html');
  url.searchParams.set('_nkw', query);
  url.searchParams.set('mkevt', '1');
  url.searchParams.set('mkcid', '1');
  url.searchParams.set('siteid', '71');
  url.searchParams.set('campid', EBAY_CAMPAIGN_ID);
  return url.toString();
}

// Recherches Google orientées par mot-clé — évite d'avoir besoin d'identifier
// précisément l'objet : Google fait le travail à partir du code brut ou du
// titre déjà connu.
const SEARCH_FILTERS = [
  { label: 'Neuf', suffix: 'prix neuf' },
  { label: 'Occasion', suffix: 'prix occasion' },
  { label: 'Avis', suffix: 'avis test' },
  { label: 'Comparatif', suffix: 'comparatif' },
  { label: 'Notice', suffix: 'notice manuel pdf' }
];

function buildFilteredSearchUrl(query, suffix) {
  return buildGoogleUrl(`${query} ${suffix}`);
}

// Requête enrichie auteur(s)/éditeur pour les livres — un simple titre comme
// "Les Dinosaures" est trop générique pour retrouver la bonne édition sur un
// moteur de recherche généraliste.
function buildSearchQuery(item) {
  const parts = [item.title];
  if (item.author) parts.push(item.author);
  if (item.publisher) parts.push(item.publisher);
  return parts.join(' ');
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
    publisher: null,
    condition: DEFAULT_CONDITION,
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
  const title = isUrl(code) ? guessTitleFromUrl(code) : code;
  const item = createAndQueueItem({ type, code, title });

  if (type === 'livre') {
    identifyBook(item);
  } else if (isUrl(code)) {
    // Titre déduit de l'URL (heuristique) plutôt que l'URL brute — pas
    // toujours parfait, d'où l'invitation à vérifier plutôt qu'un silence.
    showToast('QR code détecté — titre déduit du lien, vérifiez si besoin 🔗');
    enrichEbayPrice(item);
  } else {
    identifyProduct(item);
  }
}

async function identifyProduct(item) {
  showToast('Recherche du produit... 🔍');
  const found = await lookupProduct(item.code);
  const current = items.find((i) => i.id === item.id);
  if (!current) return; // supprimé entre-temps
  if (found?.quotaExceeded) {
    showToast(FREE_QUOTA_MESSAGE, true);
  } else if (found?.title) {
    current.title = found.title;
    current.publisher = found.brand;
    showToast('Produit trouvé ! ✨');
  } else {
    showToast('Produit non trouvé — renommez le titre si besoin 📦', true);
  }
  saveItems();
  render();
  enrichEbayPrice(current);
}

async function identifyBook(item) {
  showToast('Recherche du livre... 📚');
  const found = await lookupISBN(item.code);
  const current = items.find((i) => i.id === item.id);
  if (!current) return; // supprimé entre-temps
  if (found?.quotaExceeded) {
    showToast(FREE_QUOTA_MESSAGE, true);
  } else if (found?.title) {
    current.title = found.title;
    current.author = found.author;
    current.publisher = found.publisher;
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
      (item.author ? ` ${item.author}` : '') +
      (item.publisher ? ` · ${item.publisher}` : '') + ` · ${item.code}`;
    body.appendChild(meta);

    let price;
    if (item.priceStatus === 'pending') {
      price = document.createElement('div');
      price.className = 'item-price pending';
      price.textContent = 'Recherche du prix eBay...';
    } else if (item.priceStatus === 'found') {
      if (item.ebayUrl) {
        // Badge cliquable vers l'annonce précise trouvée — le bouton "eBay"
        // à côté reste une recherche classique, plus sûre en cas de mauvais
        // match (voir buildEbayUrl plus haut).
        price = document.createElement('a');
        price.href = item.ebayUrl;
        price.target = '_blank';
        price.rel = 'noopener';
      } else {
        price = document.createElement('div');
      }
      price.className = 'item-price found';
      price.textContent = `dès ${item.ebayPrice} € sur eBay`;
    } else {
      price = document.createElement('div');
      price.className = 'item-price pending';
      price.textContent = 'Prix eBay non trouvé';
    }
    body.appendChild(price);

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    actions.appendChild(makeCopyBtn(item));
    body.appendChild(actions);

    const links = document.createElement('div');
    links.className = 'item-links';
    // Lien direct en premier si le code scanné est une URL (QR code) — la
    // source la plus fiable, avant les recherches génériques par titre.
    if (isUrl(item.code)) links.appendChild(makeLinkBtn('🔗 Page produit', item.code));
    const query = buildSearchQuery(item);
    links.appendChild(makeBrandLinkBtn('google', 'Google', buildGoogleUrl(query)));
    links.appendChild(makeBrandLinkBtn('amazon', 'Amazon', buildAmazonUrl(buildStrictSearchQuery(item))));
    links.appendChild(makeBrandLinkBtn('vinted', 'Vinted', buildVintedUrl(buildStrictSearchQuery(item))));
    links.appendChild(makeBrandLinkBtn('etsy', 'Etsy', buildEtsyUrl(query)));
    links.appendChild(makeBrandLinkBtn('ebay', 'eBay', buildEbayUrl(buildStrictSearchQuery(item))));
    body.appendChild(links);

    const filterLinks = document.createElement('div');
    filterLinks.className = 'item-links item-filter-links';
    for (const f of SEARCH_FILTERS) {
      filterLinks.appendChild(makeLinkBtn(f.label, buildFilteredSearchUrl(query, f.suffix)));
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

// États proposés dans la fenêtre "Créer une annonce" — vocabulaire dicté par
// l'utilisateur, assez générique pour rester compréhensible tel quel collé
// dans la description Vinted/Leboncoin/eBay malgré leurs propres libellés.
const CONDITIONS = ['Mauvais état', 'Bon état', 'Très bon état', 'État neuf'];
const DEFAULT_CONDITION = 'Bon état';

// Objet en cours d'édition dans la fenêtre "Créer une annonce" (un seul à la
// fois, la fenêtre est modale).
let currentAdItem = null;

// Texte type d'annonce, différent livre/objet générique (jeu, jouet...) —
// l'état choisi est injecté directement dans la phrase plutôt qu'affiché en
// simple métadonnée à part, pour donner un texte déjà prêt à publier tel quel.
function buildAdText(item, condition) {
  const priceLine = item.priceStatus === 'found'
    ? `Prix indicatif du marché (eBay) : ${item.ebayPrice} €`
    : 'Prix à négocier selon le marché de l\'occasion.';

  if (item.type === 'livre') {
    const lines = [`📚 ${item.title}`];
    if (item.author) lines.push(`Auteur : ${item.author}`);
    if (item.publisher) lines.push(`Éditeur : ${item.publisher}`);
    lines.push('');
    lines.push(`Livre en ${condition.toLowerCase()}, vendu par un particulier. N'hésitez pas à demander des photos supplémentaires ou des précisions avant achat.`);
    lines.push('');
    lines.push(priceLine);
    return lines.join('\n');
  }

  const lines = [`📦 ${item.title}`];
  if (item.publisher) lines.push(`Marque/éditeur : ${item.publisher}`);
  lines.push('');
  lines.push(`Article en ${condition.toLowerCase()}, vendu par un particulier. N'hésitez pas à demander des photos supplémentaires ou des précisions avant achat.`);
  lines.push('');
  lines.push(priceLine);
  return lines.join('\n');
}

function renderAdConditionPicker() {
  const wrap = document.getElementById('ad-condition-picker');
  wrap.innerHTML = '';
  for (const c of CONDITIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'condition-chip' + (currentAdItem.condition === c ? ' selected' : '');
    chip.textContent = c;
    chip.addEventListener('click', () => {
      currentAdItem.condition = c;
      saveItems();
      document.getElementById('fiche-textarea').value = buildAdText(currentAdItem, c);
      renderAdConditionPicker();
    });
    wrap.appendChild(chip);
  }
}

// Modèles d'annonce enregistrés par l'utilisateur (texte libre, tel quel —
// pas de placeholder à substituer, cohérent avec le reste de l'appli qui
// préfère laisser l'utilisateur retoucher le texte à la main plutôt que de
// tout automatiser). Chargé dans le textarea, il remplace l'annonce
// auto-générée ; l'utilisateur ajuste ensuite titre/état si besoin avant de
// copier.
function renderAdTemplateSelect() {
  const select = document.getElementById('ad-template-select');
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = adTemplates.length ? 'Charger un modèle enregistré...' : 'Aucun modèle enregistré';
  select.appendChild(placeholder);
  for (const tpl of adTemplates) {
    const opt = document.createElement('option');
    opt.value = tpl.id;
    opt.textContent = tpl.name;
    select.appendChild(opt);
  }
}

function saveCurrentAsAdTemplate() {
  const text = document.getElementById('fiche-textarea').value;
  if (!text.trim()) return;
  const name = prompt("Nom de ce modèle d'annonce :");
  if (!name || !name.trim()) return;
  const trimmedName = name.trim();
  const existing = adTemplates.find((t) => t.name.toLowerCase() === trimmedName.toLowerCase());
  if (existing) {
    if (!confirm(`Un modèle "${trimmedName}" existe déjà — le remplacer ?`)) return;
    existing.text = text;
  } else {
    adTemplates.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
      name: trimmedName,
      text
    });
  }
  saveAdTemplates();
  renderAdTemplateSelect();
  document.getElementById('ad-template-select').value = existing ? existing.id : adTemplates[adTemplates.length - 1].id;
  showToast(`Modèle "${trimmedName}" enregistré ✅`);
}

function applySelectedAdTemplate() {
  const select = document.getElementById('ad-template-select');
  const tpl = adTemplates.find((t) => t.id === select.value);
  if (!tpl) return;
  document.getElementById('fiche-textarea').value = tpl.text;
}

function deleteSelectedAdTemplate() {
  const select = document.getElementById('ad-template-select');
  const tpl = adTemplates.find((t) => t.id === select.value);
  if (!tpl) return;
  if (!confirm(`Supprimer le modèle "${tpl.name}" ?`)) return;
  adTemplates = adTemplates.filter((t) => t.id !== tpl.id);
  saveAdTemplates();
  renderAdTemplateSelect();
}

function openAdModal(item) {
  currentAdItem = item;
  renderAdConditionPicker();
  renderAdTemplateSelect();
  document.getElementById('ad-template-select').value = '';
  document.getElementById('fiche-textarea').value = buildAdText(item, item.condition || DEFAULT_CONDITION);
  document.getElementById('fiche-modal').style.display = 'flex';
}

function closeFicheModal() {
  document.getElementById('fiche-modal').style.display = 'none';
}

async function confirmCopyFiche() {
  const text = document.getElementById('fiche-textarea').value;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Annonce copiée — colle-la dans Vinted/Leboncoin 📋');
  } catch {
    showToast("Impossible de copier automatiquement — copiez le texte manuellement.", true);
  }
  closeFicheModal();
}

function makeCopyBtn(item) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-fiche-btn';
  btn.textContent = '📝 Créer une annonce';
  btn.addEventListener('click', () => openAdModal(item));
  return btn;
}

function makeLinkBtn(label, url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = label;
  return a;
}

// Bouton avec icône de marque officielle (Simple Icons, colorée en CSS via
// mask sur `.icon-<brand>`) au lieu d'un simple libellé texte — plus gros
// (voir .brand-btn dans style.css) pour rester tapable facilement.
function makeBrandLinkBtn(brand, label, url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.className = 'brand-btn';
  const icon = document.createElement('span');
  icon.className = `brand-icon icon-${brand}`;
  icon.setAttribute('aria-hidden', 'true');
  a.appendChild(icon);
  a.appendChild(document.createTextNode(label));
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
  if (item) window.open(buildGoogleUrl(buildSearchQuery(item)), '_blank');
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
  return openScanner({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
    statusText: 'Pointez vers le code-barre...',
    makeZxingReader: () => new ZXing.BrowserMultiFormatReader()
  });
}

async function startQrScanner() {
  return openScanner({
    formats: ['qr_code'],
    statusText: 'Pointez vers le QR code...',
    makeZxingReader: () => new ZXing.BrowserQRCodeReader()
  });
}

// Un détecteur natif dédié par bouton (jamais code-barre + QR dans la même
// instance BarcodeDetector) : sur Android, les mélanger a déjà cassé TOUTE
// la détection le temps qu'un module Play Services (ML Kit) supplémentaire
// se charge pour le format QR — même les codes-barres classiques ne
// remontaient plus. Séparer les deux isole le risque au bouton QR seul.
async function openScanner({ formats, statusText, makeZxingReader }) {
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
    status.textContent = statusText;

    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats });
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
        status.textContent = statusText;
        const codeReader = makeZxingReader();
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
    console.error('openScanner:', err);
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
  document.getElementById('qr-scan-btn').addEventListener('click', startQrScanner);
  document.getElementById('scanner-close-btn').addEventListener('click', stopBarcodeScanner);
  document.getElementById('manual-add-btn').addEventListener('click', manualAdd);

  document.getElementById('select-all').addEventListener('change', (e) => {
    document.querySelectorAll('.item-select').forEach((c) => { c.checked = e.target.checked; });
    updateBatchButtonsState();
  });
  document.getElementById('open-selected-btn').addEventListener('click', startSequentialOpen);
  document.getElementById('clear-all-btn').addEventListener('click', clearAllItems);

  document.getElementById('fiche-cancel-btn').addEventListener('click', closeFicheModal);
  document.getElementById('fiche-confirm-btn').addEventListener('click', confirmCopyFiche);
  document.getElementById('fiche-save-template-btn').addEventListener('click', saveCurrentAsAdTemplate);
  document.getElementById('ad-template-select').addEventListener('change', applySelectedAdTemplate);
  document.getElementById('ad-template-delete-btn').addEventListener('click', deleteSelectedAdTemplate);

  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', initUI);
