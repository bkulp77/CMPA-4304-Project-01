const STORAGE_KEY = 'bookInventoryCSV';
const tableBody = document.getElementById('table-body');
let inventoryData = [];
let lastRenderedRows = [];
let photoTargetRow = null;
const HEADERS = ['id','title','author','genre','format','year','isbn','status','quantity','room','bookshelf','shelf','image','summary'];

function escapeCsvField(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function arrayToCsv(rows) {
  return [HEADERS.join(',')].concat((rows || []).map(row => HEADERS.map(h => escapeCsvField(row[h] ?? '')).join(','))).join('\n');
}
function parseCsv(text) {
  if (!text) return [];
  const rows = [];
  let i = 0;
  const len = text.length;
  function readField() {
    let field = '';
    if (text[i] === '"') {
      i++;
      while (i < len) {
        if (text[i] === '"' && text[i + 1] === '"') { field += '"'; i += 2; }
        else if (text[i] === '"') { i++; break; }
        else field += text[i++];
      }
    } else while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') field += text[i++];
    return field;
  }
  if (text.charCodeAt(0) === 0xFEFF) i = 1;
  while (i < len) {
    const row = [];
    while (i < len) { row.push(readField()); if (text[i] === ',') i++; else break; }
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(cols => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ''; });
    obj.id = obj.id || String(Date.now() + Math.random());
    obj.quantity = parseInt(obj.quantity, 10) || 0;
    return obj;
  });
}
async function saveInventory() {
  const csv = arrayToCsv(inventoryData);
  const previous = localStorage.getItem(STORAGE_KEY) || '';
  if (previous.length > 1000 && csv.length < previous.length * 0.5) {
    if (!confirm('This save is much smaller than the shelf already stored. Continue only if you meant to delete books.')) throw new Error('Save cancelled.');
  }
  localStorage.setItem(STORAGE_KEY, csv);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
}
function sortItems(rows) {
  rows.sort((a, b) => String(a.author || '').localeCompare(String(b.author || '')) || String(a.title || '').localeCompare(String(b.title || '')));
}
let pendingCoverImage = '';
let pendingSummary = '';

async function fetchCoverAsDataUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return '';
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return '';
  }
}

async function fillFromBookData(info, preferredIsbn) {
  document.getElementById('form-title').value = info.title || '';
  document.getElementById('form-author').value = info.author || '';
  document.getElementById('form-year').value = info.year || '';
  if (preferredIsbn) {
    document.getElementById('form-isbn').value = preferredIsbn;
  } else if (info.isbn) {
    document.getElementById('form-isbn').value = info.isbn;
  }
  const genreSelect = document.getElementById('form-genre');
  if (info.subjects && info.subjects.length) {
    const subjects = info.subjects.map(s => String(s).toLowerCase());
    const options = Array.from(genreSelect.options).map(o => o.value.toLowerCase());
    const match = options.find(opt => subjects.some(sub => sub.includes(opt) || opt.includes(sub)));
    if (match) genreSelect.value = genreSelect.options[options.indexOf(match)].value;
  }
  pendingCoverImage = '';
  pendingSummary = info.summary || '';
  if (info.coverUrl) {
    const dataUrl = await fetchCoverAsDataUrl(info.coverUrl);
    pendingCoverImage = dataUrl || info.coverUrl;
  }
}

async function tryGoogleBooks(cleanIsbn, title, author, year) {
  let q = '';
  if (cleanIsbn.length >= 10) {
    q = `isbn:${cleanIsbn}`;
  } else if (title || author) {
    const parts = [];
    if (title) parts.push(`intitle:${encodeURIComponent(title)}`);
    if (author) parts.push(`inauthor:${encodeURIComponent(author)}`);
    q = parts.join('+');
  } else return null;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) return null;
    let item = items[0];
    if (year && /^\d{4}$/.test(year)) {
      const ym = items.find(it => (it.volumeInfo.publishedDate || '').startsWith(year));
      if (ym) item = ym;
    }
    const vi = item.volumeInfo || {};
    const ids = vi.industryIdentifiers || [];
    const isbn13 = ids.find(i => i.type === 'ISBN_13');
    const isbn10 = ids.find(i => i.type === 'ISBN_10');
    const isbn = (isbn13 && isbn13.identifier) || (isbn10 && isbn10.identifier) || cleanIsbn || '';
    let coverUrl = '';
    if (vi.imageLinks) {
      coverUrl = (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail || '').replace(/^http:/, 'https:');
      if (vi.imageLinks.small) coverUrl = vi.imageLinks.small.replace(/^http:/, 'https:');
    }
    return {
      title: vi.title || '',
      author: (vi.authors && vi.authors[0]) || '',
      year: (vi.publishedDate || '').slice(0, 4),
      isbn,
      subjects: vi.categories || [],
      coverUrl,
      summary: vi.description || ''
    };
  } catch (e) {
    return null;
  }
}

async function tryOpenLibrary(cleanIsbn, title, author, year) {
  let url = '';
  if (cleanIsbn.length >= 10) {
    url = `https://openlibrary.org/search.json?q=isbn:${cleanIsbn}&fields=title,author_name,first_publish_year,subject,cover_i,isbn&limit=5`;
  } else if (title || author) {
    const params = new URLSearchParams();
    if (title) params.set('title', title);
    if (author) params.set('author', author);
    if (year && /^\d{4}$/.test(year)) params.set('first_publish_year', year);
    params.set('fields', 'title,author_name,first_publish_year,subject,cover_i,isbn');
    params.set('limit', '5');
    url = `https://openlibrary.org/search.json?${params.toString()}`;
  } else return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const docs = data.docs || [];
    if (!docs.length) return null;
    let doc = docs[0];
    if (year && /^\d{4}$/.test(year) && cleanIsbn.length < 10) {
      const ym = docs.find(d => String(d.first_publish_year) === year);
      if (ym) doc = ym;
    }
    const isbnList = doc.isbn || [];
    const isbn13 = isbnList.find(i => String(i).replace(/[^0-9]/g, '').length === 13);
    const isbn = isbn13 || isbnList[0] || cleanIsbn || '';
    let coverUrl = '';
    if (doc.cover_i) coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
    else if (isbn) coverUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
    return {
      title: doc.title || '',
      author: (doc.author_name && doc.author_name[0]) || '',
      year: doc.first_publish_year || '',
      isbn,
      subjects: doc.subject || [],
      coverUrl,
      summary: ''
    };
  } catch (e) {
    return null;
  }
}

async function lookupBook() {
  const isbnRaw = document.getElementById('form-isbn').value;
  const title = document.getElementById('form-title').value.trim();
  const author = document.getElementById('form-author').value.trim();
  const year = document.getElementById('form-year').value.trim();
  const cleanIsbn = String(isbnRaw || '').replace(/[^0-9Xx]/g, '').toUpperCase();

  const btn = document.getElementById('lookup-isbn-btn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Looking up...';

  try {
    if (cleanIsbn.length < 10 && !title && !author) {
      alert('Enter an ISBN, or at least a title or author, then click Lookup.');
      return;
    }

    let info = await tryGoogleBooks(cleanIsbn, title, author, year);
    let source = 'Google Books';
    if (!info || !info.title) {
      info = await tryOpenLibrary(cleanIsbn, title, author, year);
      source = 'Open Library';
    }
    if (!info || !info.title) {
      throw new Error('No matching books found in Google Books or Open Library');
    }

    await fillFromBookData(info, cleanIsbn.length >= 10 ? cleanIsbn : null);
    alert(`Book details filled from ${source}. Cover and summary (if available) will be saved with the book.`);
  } catch (err) {
    alert('Could not look up book: ' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

document.getElementById('lookup-isbn-btn').addEventListener('click', lookupBook);

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read photo'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read photo'));
      img.onload = () => {
        const scale = Math.min(1, 640 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function ensurePhotoPicker() {
  let input = document.getElementById('photo-picker');
  if (input) return input;
  input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.hidden = true;
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    const row = photoTargetRow;
    input.value = '';
    if (!file || !row) return;
    try { row.image = await readImage(file); await saveInventory(); renderCurrentView(); }
    catch (err) { alert('Could not save photo: ' + (err.message || err)); }
  });
  document.body.appendChild(input);
  return input;
}
function bindEditable(cell, row, field, display) {
  cell.classList.add('editable');
  cell.title = 'Tap to edit';
  cell.innerHTML = display;
  cell.addEventListener('click', (event) => {
    event.stopPropagation();
    if (cell.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.enterKeyHint = 'done';
    input.value = row[field] == null ? '' : String(row[field]);
    input.className = 'cell-editor';
    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save) row[field] = input.value.trim();
      if (save) { try { await saveInventory(); } catch (err) { alert(err.message || err); } }
      renderCurrentView();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });
}
function updateSummary(rows) {
  const dashboard = document.getElementById('summary');
  const totals = {};
  let count = 0;
  let reading = 0;
  (rows || []).forEach(row => {
    const qty = parseInt(row.quantity, 10) || 0;
    if (qty <= 0) return;
    count += qty;
    if (String(row.status || '').toLowerCase() === 'reading') reading += qty;
    const genre = String(row.genre || 'Other').trim();
    totals[genre] = (totals[genre] || 0) + qty;
  });
  const cards = Object.keys(totals).sort().map(genre => `<div class="summary-card"><h4>${escapeHtml(genre)}</h4><div class="summary-count">${totals[genre]}</div></div>`).join('');
  const badges = Object.keys(totals).sort().map(genre => `<span class="badge">${escapeHtml(genre)}: <strong>${totals[genre]}</strong></span>`).join('');
  dashboard.innerHTML = `<div class="summary-row"><div class="summary-card"><h4>Books</h4><div class="summary-count">${count}</div></div><div class="summary-card"><h4>Reading</h4><div class="summary-count">${reading}</div></div>${cards}</div><div class="badges">${badges || '<span class="badge">Nothing logged yet</span>'}</div>`;
}
function renderTable(rows) {
  lastRenderedRows = rows || [];
  updateSummary(rows);
  tableBody.innerHTML = '';
  if (!rows.length) {
    tableBody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:20px;color:#5E6A72;">The shelf is empty. Add a book above.</td></tr>';
    return;
  }
  rows.forEach(row => {
    const tr = document.createElement('tr');
    const imagePath = row.image ? String(row.image).trim() : '';
    const qty = parseInt(row.quantity, 10) || 0;
    tr.innerHTML = `
      <td><div class="img-cell-wrapper" title="Tap to add or replace photo">${imagePath ? `<img src="${imagePath}" class="item-pic" alt="">` : ''}<div class="item-pic" style="${imagePath ? 'display:none;' : 'display:flex;'}">📖</div><span class="photo-edit-hint">+</span></div></td>
      <td class="edit-title"></td><td class="edit-author"></td><td class="edit-genre"></td><td class="edit-format"></td><td class="edit-year"></td>
      <td class="edit-status"></td>
      <td><div class="qty-controls"><button class="btn-qty minus" type="button">−</button><span>${qty}</span><button class="btn-qty plus" type="button">+</button></div></td>
      <td class="edit-room"></td>
      <td class="edit-bookshelf"></td>
      <td class="edit-shelf"></td>
      <td><button class="notes-btn edit-btn" type="button">Edit</button></td>`;
    tr.querySelector('.img-cell-wrapper').addEventListener('click', (event) => {
      event.preventDefault();
      photoTargetRow = row;
      ensurePhotoPicker().click();
    });
    bindEditable(tr.querySelector('.edit-title'), row, 'title', `<strong>${escapeHtml(row.title || '')}</strong>`);
    bindEditable(tr.querySelector('.edit-author'), row, 'author', escapeHtml(row.author || ''));
    bindEditable(tr.querySelector('.edit-genre'), row, 'genre', escapeHtml(row.genre || ''));
    bindEditable(tr.querySelector('.edit-format'), row, 'format', escapeHtml(row.format || ''));
    bindEditable(tr.querySelector('.edit-year'), row, 'year', escapeHtml(row.year || ''));
    bindEditable(tr.querySelector('.edit-status'), row, 'status', escapeHtml(row.status || ''));
    bindEditable(tr.querySelector('.edit-room'), row, 'room', escapeHtml(row.room || ''));
    bindEditable(tr.querySelector('.edit-bookshelf'), row, 'bookshelf', escapeHtml(row.bookshelf || ''));
    bindEditable(tr.querySelector('.edit-shelf'), row, 'shelf', escapeHtml(row.shelf || ''));
    tr.querySelector('.edit-btn').addEventListener('click', () => openEdit(row));
    tr.querySelector('.minus').addEventListener('click', async () => {
      row.quantity = Math.max(0, (parseInt(row.quantity, 10) || 0) - 1);
      if (row.quantity === 0) inventoryData = inventoryData.filter(item => item.id !== row.id);
      await saveInventory();
      renderCurrentView();
    });
    tr.querySelector('.plus').addEventListener('click', async () => {
      row.quantity = (parseInt(row.quantity, 10) || 0) + 1;
      await saveInventory();
      renderCurrentView();
    });
    tableBody.appendChild(tr);
  });
}
function renderShelf(rows) {
  const board = document.getElementById('shelf-board');
  board.innerHTML = '';
  if (!rows.length) {
    board.innerHTML = '<p style="text-align:center;color:#5E6A72;padding:20px;">No books to show on the shelf. Add some above.</p>';
    return;
  }
  const groups = {};
  rows.forEach(row => {
    const room = row.room || 'Unassigned';
    const bookshelf = row.bookshelf || 'Unassigned';
    const shelf = row.shelf || '1';
    const key = `${room}|||${bookshelf}|||${shelf}`;
    if (!groups[key]) groups[key] = { room, bookshelf, shelf, books: [] };
    groups[key].books.push(row);
  });
  const sortedKeys = Object.keys(groups).sort();
  sortedKeys.forEach(key => {
    const g = groups[key];
    const unit = document.createElement('div');
    unit.className = 'shelf-unit';
    unit.innerHTML = `<div class="shelf-label"><span>${escapeHtml(g.room)} · ${escapeHtml(g.bookshelf)} · Shelf ${escapeHtml(g.shelf)}</span><span>${g.books.length} book${g.books.length === 1 ? '' : 's'}</span></div><div class="shelf-plank"></div>`;
    const plank = unit.querySelector('.shelf-plank');
    g.books.forEach(book => {
      const spine = document.createElement('div');
      spine.className = 'spine';
      const status = String(book.status || '').toLowerCase();
      if (status === 'reading') spine.classList.add('reading');
      else if (status === 'read') spine.classList.add('read');
      else if (status === 'want') spine.classList.add('want');
      spine.title = `${book.title || ''} by ${book.author || ''}`;
      spine.textContent = (book.title || 'Untitled').slice(0, 22);
      plank.appendChild(spine);
    });
    board.appendChild(unit);
  });
}
let currentView = 'table';
function renderCurrentView() {
  const rows = lastRenderedRows.length ? lastRenderedRows : inventoryData;
  updateSummary(rows);
  if (currentView === 'shelf') {
    document.getElementById('table-view').style.display = 'none';
    document.getElementById('shelf-view').style.display = 'block';
    renderShelf(rows);
  } else {
    document.getElementById('table-view').style.display = 'block';
    document.getElementById('shelf-view').style.display = 'none';
    renderTable(rows);
  }
}
document.getElementById('view-table-btn').addEventListener('click', () => {
  currentView = 'table';
  document.getElementById('view-table-btn').classList.add('active');
  document.getElementById('view-shelf-btn').classList.remove('active');
  renderCurrentView();
});
document.getElementById('view-shelf-btn').addEventListener('click', () => {
  currentView = 'shelf';
  document.getElementById('view-shelf-btn').classList.add('active');
  document.getElementById('view-table-btn').classList.remove('active');
  renderCurrentView();
});
function openEdit(row) {
  document.getElementById('edit-id').value = row.id;
  document.getElementById('edit-title').textContent = `Edit ${row.title || 'book'}`;
  document.getElementById('edit-title-field').value = row.title || '';
  document.getElementById('edit-author').value = row.author || '';
  document.getElementById('edit-genre').value = row.genre || '';
  document.getElementById('edit-format').value = row.format || '';
  document.getElementById('edit-year').value = row.year || '';
  document.getElementById('edit-isbn').value = row.isbn || '';
  document.getElementById('edit-status').value = row.status || '';
  document.getElementById('edit-room').value = row.room || '';
  document.getElementById('edit-bookshelf').value = row.bookshelf || '';
  document.getElementById('edit-shelf').value = row.shelf || '';
  document.getElementById('edit-summary').value = row.summary || '';
  document.getElementById('edit-modal').style.display = 'flex';
}
document.getElementById('close-edit-btn').addEventListener('click', () => { document.getElementById('edit-modal').style.display = 'none'; });
document.getElementById('save-edit-btn').addEventListener('click', async () => {
  const match = inventoryData.find(item => String(item.id) === document.getElementById('edit-id').value);
  if (!match) return;
  match.title = document.getElementById('edit-title-field').value.trim();
  match.author = document.getElementById('edit-author').value.trim();
  match.genre = document.getElementById('edit-genre').value.trim();
  match.format = document.getElementById('edit-format').value.trim();
  match.year = document.getElementById('edit-year').value.trim();
  match.isbn = document.getElementById('edit-isbn').value.trim();
  match.status = document.getElementById('edit-status').value.trim();
  match.room = document.getElementById('edit-room').value.trim();
  match.bookshelf = document.getElementById('edit-bookshelf').value.trim();
  match.shelf = document.getElementById('edit-shelf').value.trim();
  match.summary = document.getElementById('edit-summary').value.trim();
  await saveInventory();
  document.getElementById('edit-modal').style.display = 'none';
  sortItems(inventoryData);
  lastRenderedRows = inventoryData;
  renderCurrentView();
});
document.getElementById('item-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  let image = pendingCoverImage || '';
  const file = document.getElementById('form-image').files[0];
  if (file) { try { image = await readImage(file); } catch (err) { alert('Could not process photo. Saving without it.'); } }
  inventoryData.push({
    id: String(Date.now()),
    title: document.getElementById('form-title').value.trim(),
    author: document.getElementById('form-author').value.trim(),
    genre: document.getElementById('form-genre').value,
    format: document.getElementById('form-format').value,
    year: document.getElementById('form-year').value.trim(),
    isbn: document.getElementById('form-isbn').value.trim(),
    status: document.getElementById('form-status').value,
    quantity: parseInt(document.getElementById('form-qty').value, 10) || 1,
    room: document.getElementById('form-room').value.trim(),
    bookshelf: document.getElementById('form-bookshelf').value.trim(),
    shelf: document.getElementById('form-shelf').value.trim(),
    image,
    summary: pendingSummary || ''
  });
  pendingCoverImage = '';
  pendingSummary = '';
  await saveInventory();
  event.target.reset();
  document.getElementById('form-qty').value = '1';
  button.disabled = false;
  sortItems(inventoryData);
  lastRenderedRows = inventoryData;
  renderCurrentView();
});
document.getElementById('search-box').addEventListener('input', (event) => {
  const query = event.target.value.toLowerCase();
  lastRenderedRows = inventoryData.filter(row => ['title','author','genre','format','year','isbn','status','room','bookshelf','shelf','summary'].some(field => String(row[field] || '').toLowerCase().includes(query)));
  renderCurrentView();
});
document.getElementById('csv-download-btn').addEventListener('click', () => {
  const csv = arrayToCsv(inventoryData);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'book-inventory.csv';
  a.click();
  URL.revokeObjectURL(url);
});
document.getElementById('csv-upload-input').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = parseCsv(text);
    if (!parsed.length) { alert('No books found in that CSV.'); return; }
    if (!confirm(`Replace current inventory with ${parsed.length} book(s) from the file?`)) return;
    inventoryData = parsed;
    sortItems(inventoryData);
    await saveInventory();
    lastRenderedRows = inventoryData;
    renderCurrentView();
    alert('Inventory imported.');
  } catch (err) {
    alert('Could not import CSV: ' + (err.message || err));
  }
});
inventoryData = parseCsv(localStorage.getItem(STORAGE_KEY) || '');
sortItems(inventoryData);
lastRenderedRows = inventoryData;
renderCurrentView();
