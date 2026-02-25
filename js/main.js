const trackListEl = document.getElementById("tracklist");
const fileInput = document.getElementById("fileInput");
const saveBtn = document.getElementById("savePlaylistBtn");
const clearBtn = document.getElementById("clearPlaylistBtn");
const importBtn = document.getElementById("importPlaylistBtn");
const importInput = document.getElementById("importInput");
const uploadContainer = document.getElementById('uploadContainer');
const uploadStatusEl = document.getElementById('uploadStatus');
const coverPicker = document.getElementById('coverPicker');
const navToggle = document.getElementById('navToggle');
const navLinks = document.querySelector('.nav-links');
const navLinkElements = document.querySelectorAll('.nav-link');

// flag so user isn't spammed with alerts
let notifiedStorageFallback = false;

// indicates async save operation in progress (prevents refresh loss)
let isSaving = false;

// IndexedDB helpers
function openDatabase() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('music_player', 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('tracks')) {
                db.createObjectStore('tracks', { keyPath: 'id' });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

// attach one-time global dragover/drop handlers for reordering
if (trackListEl) {
    trackListEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        const after = [...trackListEl.querySelectorAll('li')].find(child => {
            const rect = child.getBoundingClientRect();
            return e.clientY < rect.top + rect.height / 2;
        });
        const dragging = trackListEl.querySelector('.dragging');
        if (!dragging) return;
        if (after) trackListEl.insertBefore(dragging, after);
        else trackListEl.appendChild(dragging);
    });

    trackListEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const currentPlayingId = (typeof currentIndex !== 'undefined' && currentIndex !== null && window.tracks[currentIndex]) ? window.tracks[currentIndex].id : null;
        // compute to index from DOM order
        const nodes = [...trackListEl.querySelectorAll('li')];
        const to = nodes.findIndex(n => parseInt(n.dataset.index, 10) === from);
        if (from >= 0 && to >= 0 && from !== to) {
            reorderArray(window.tracks, from, to);
            await saveStoredTracks();
            // restore currentIndex by id
            if (currentPlayingId !== null) {
                currentIndex = window.tracks.findIndex(t => t.id === currentPlayingId);
            }
            renderTracks();
        }
    });
}

// NAV: toggle mobile menu
if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
        navLinks.classList.toggle('active');
    });
}

// Close mobile menu when a nav link is clicked
navLinkElements.forEach(a => a.addEventListener('click', () => {
    if (navLinks && navLinks.classList.contains('active')) navLinks.classList.remove('active');
}));

// warn user if they try to navigate away while playlist is still saving
window.addEventListener('beforeunload', (e) => {
    if (isSaving) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Active-state highlight while scrolling
// Map anchors to section elements
const sectionMap = [];
navLinkElements.forEach(a => {
    const href = a.getAttribute('href');
    if (href && href.startsWith('#')) {
        const id = href.slice(1);
        const el = document.getElementById(id);
        if (el) sectionMap.push({ id, el, link: a });
    }
});

if (sectionMap.length) {
    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const found = sectionMap.find(s => s.el === entry.target);
            if (!found) return;
            if (entry.isIntersecting) {
                navLinkElements.forEach(x => x.classList.remove('active'));
                found.link.classList.add('active');
            }
        });
    }, { threshold: 0.5 });

    sectionMap.forEach(s => observer.observe(s.el));
}

async function saveTracksToIDB(tracks) {
    try {
        const db = await openDatabase();
        const tx = db.transaction('tracks', 'readwrite');
        const store = tx.objectStore('tracks');
        store.put({ id: 1, data: tracks });
        return new Promise((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } catch (e) {
        console.error('IDB save failed', e);
    }
}

async function loadTracksFromIDB() {
    try {
        const db = await openDatabase();
        const tx = db.transaction('tracks', 'readonly');
        const store = tx.objectStore('tracks');
        const req = store.get(1);
        return new Promise((res, rej) => {
            req.onsuccess = (e) => {
                const result = e.target.result;
                res(result ? result.data : null);
            };
            req.onerror = () => rej(req.error);
        });
    } catch (e) {
        console.error('IDB load failed', e);
        return null;
    }
}

async function saveStoredTracks() {
    const data = window.tracks || [];
    let savedSomething = false;
    // persist using IndexedDB only; localStorage has limited quota and often fails
    try {
        await saveTracksToIDB(data);
        console.log('saved', data.length, 'tracks to IndexedDB');
        savedSomething = true;
    } catch (e) {
        console.error('IndexedDB save failed', e);
    }

    if (!savedSomething) {
        const msg = 'Unable to persist playlist – IndexedDB unavailable or quota exceeded.';
        console.error(msg);
        if (uploadStatusEl) uploadStatusEl.textContent = msg;
        alert(msg);
    }
}

async function loadStoredTracks() {
    let stored = null;
    try {
        const idbData = await loadTracksFromIDB();
        if (Array.isArray(idbData)) {
            stored = idbData;
        }
    } catch (e) {
        console.error('Error reading from IndexedDB', e);
    }

    if (Array.isArray(stored)) {
        // merge default tracks (from data.js) with stored ones.
        // If a stored track matches an existing track by preview URL, copy metadata (cover, duration, title, artist).
        const existing = window.tracks || [];
        window.tracks = existing.slice();
        stored.forEach(st => {
            if (!st || !st.preview) return;
            const idx = window.tracks.findIndex(et => et && et.preview === st.preview);
            if (idx >= 0) {
                const target = window.tracks[idx];
                // copy useful fields from stored into existing entry
                if (st.title) target.title = st.title;
                if (st.artist) target.artist = st.artist;
                if (st.duration) target.duration = st.duration;
                if (st.cover) target.cover = st.cover;
            } else {
                // new track that didn't exist in defaults
                window.tracks.push(st);
            }
        });
        // ensure all tracks have service URL keys so uploaded/older entries render consistently
        let patched = false;
        (window.tracks || []).forEach(t => {
            if (!t) return;
            ['spotify','youtube','appleMusic','boomplay','audiomack'].forEach(k => {
                if (typeof t[k] === 'undefined') { t[k] = ''; patched = true; }
            });
        });
        if (patched) await saveStoredTracks();
    } else {
        // nothing could be loaded from storage
        if (uploadStatusEl) uploadStatusEl.textContent = 'No stored playlist found (storage may be disabled).';
        console.warn('loadStoredTracks: no stored playlist data available');
        window.tracks = window.tracks || [];
    }
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// drag-reorder helpers
function reorderArray(arr, from, to) {
    if (from === to) return arr;
    const item = arr.splice(from, 1)[0];
    arr.splice(to, 0, item);
    return arr;
}

function renderTracks() {
    if (!trackListEl) return;
    trackListEl.innerHTML = "";
    if (!window.tracks || !window.tracks.length) {
        trackListEl.innerHTML = "<li>No tracks available</li>";
        return;
    }

    window.tracks.forEach((track, index) => {
        const li = document.createElement('li');
        li.className = 'track-item';
        li.draggable = true;
        li.dataset.index = index;

        // cover
        if (track.cover) {
            const img = document.createElement('img');
            img.className = 'track-cover';
            img.src = track.cover;
            li.appendChild(img);
        } else {
            const placeholder = document.createElement('div');
            placeholder.style.width = '48px';
            placeholder.style.height = '48px';
            placeholder.style.marginRight = '8px';
            li.appendChild(placeholder);
        }

        const title = document.createElement('span');
        title.textContent = `${track.title} — ${track.artist}`;
        li.appendChild(title);

        const durationSpan = document.createElement('span');
        durationSpan.style.marginLeft = '8px';
        durationSpan.style.color = '#bbb';
        durationSpan.textContent = track.duration || '0:00';
        li.appendChild(durationSpan);

        const btn = document.createElement('button');
        btn.textContent = 'Play';
        btn.className = 'playBtn';
        btn.addEventListener('click', () => {
            if (typeof playTrackByIndex === 'function') playTrackByIndex(index);
        });

        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.className = 'removeBtn';
        removeBtn.addEventListener('click', async () => {
            // adjust current index/player if necessary
            if (typeof currentIndex !== 'undefined' && currentIndex !== null) {
                if (index === currentIndex) {
                    if (currentSound) currentSound.stop();
                    currentIndex = null;
                    if (globalPlayer) globalPlayer.classList.add('hidden');
                } else if (index < currentIndex) {
                    currentIndex -= 1;
                }
            }

            window.tracks.splice(index, 1);
            await saveStoredTracks();
            renderTracks();
        });

        const setCoverBtn = document.createElement('button');
        setCoverBtn.textContent = 'Set Cover';
        setCoverBtn.className = 'set-cover-btn';
        setCoverBtn.addEventListener('click', () => {
            if (!coverPicker) return;
            coverPicker.dataset.targetIndex = index;
            coverPicker.click();
        });

        const removeCoverBtn = document.createElement('button');
        removeCoverBtn.textContent = 'Remove Cover';
        removeCoverBtn.className = 'remove-cover-btn';
        removeCoverBtn.addEventListener('click', async () => {
            if (!window.tracks || !window.tracks[index]) return;
            window.tracks[index].cover = null;
            await saveStoredTracks();
            // if this track is currently playing, hide player thumbnail
            const playerCoverEl = document.getElementById('playerCover');
            if (typeof currentIndex !== 'undefined' && currentIndex === index && playerCoverEl) {
                playerCoverEl.src = '';
                playerCoverEl.classList.add('hidden');
            }
            renderTracks();
        });

        li.appendChild(btn);
        li.appendChild(removeBtn);
        li.appendChild(setCoverBtn);
        li.appendChild(removeCoverBtn);

        // Edit Links button to set external service URLs for this track
        const editLinksBtn = document.createElement('button');
        editLinksBtn.textContent = 'Edit Links';
        editLinksBtn.className = 'set-cover-btn';
        editLinksBtn.addEventListener('click', async () => {
            // toggle inline editor
            const existing = li.querySelector('.links-editor');
            if (existing) { existing.remove(); return; }

            const servicesDef = [
                { key: 'spotify', label: 'Spotify' },
                { key: 'youtube', label: 'YouTube' },
                { key: 'appleMusic', label: 'Apple Music' },
                { key: 'boomplay', label: 'Boomplay' },
                { key: 'audiomack', label: 'Audiomack' }
            ];

            const editor = document.createElement('div');
            editor.className = 'links-editor';

            servicesDef.forEach(s => {
                const row = document.createElement('div');
                row.className = 'links-row';
                const label = document.createElement('div');
                label.style.minWidth = '90px';
                label.style.color = '#bbb';
                label.textContent = s.label;
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'link-input';
                input.placeholder = `${s.label} URL`;
                input.value = (window.tracks[index] && window.tracks[index][s.key]) ? window.tracks[index][s.key] : '';
                input.dataset.key = s.key;
                row.appendChild(label);
                row.appendChild(input);
                editor.appendChild(row);
            });

            const actions = document.createElement('div');
            actions.className = 'link-actions';
            const saveBtnLocal = document.createElement('button');
            saveBtnLocal.textContent = 'Save';
            saveBtnLocal.className = 'link-save';
            const cancelBtnLocal = document.createElement('button');
            cancelBtnLocal.textContent = 'Cancel';
            cancelBtnLocal.className = 'link-cancel';

            saveBtnLocal.addEventListener('click', async () => {
                const inputs = editor.querySelectorAll('.link-input');
                inputs.forEach(inp => {
                    const k = inp.dataset.key;
                    if (!window.tracks[index]) return;
                    window.tracks[index][k] = (inp.value || '').trim();
                });
                await saveStoredTracks();
                renderTracks();
            });

            cancelBtnLocal.addEventListener('click', () => { editor.remove(); });

            actions.appendChild(cancelBtnLocal);
            actions.appendChild(saveBtnLocal);
            editor.appendChild(actions);
            li.appendChild(editor);
            // focus first input
            const firstInp = editor.querySelector('.link-input');
            if (firstInp) firstInp.focus();
        });
        li.appendChild(editLinksBtn);

        // service icon links container
        const serviceLinks = document.createElement('div');
        serviceLinks.className = 'service-links';
        const services = [
            { key: 'spotify', icon: 'fa-brands fa-spotify', cls: 'spotify' },
            { key: 'youtube', icon: 'fa-brands fa-youtube', cls: 'youtube' },
            { key: 'appleMusic', icon: 'fa-brands fa-apple', cls: 'apple' },
            { key: 'boomplay', icon: 'fa-solid fa-headphones', cls: 'boomplay' },
            { key: 'audiomack', icon: 'fa-solid fa-compact-disc', cls: 'audiomack' }
        ];
        services.forEach(s => {
            if (track[s.key]) {
                const a = document.createElement('a');
                a.href = track[s.key];
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.className = `service-link ${s.cls}`;
                a.title = s.key;
                const i = document.createElement('i');
                i.className = s.icon;
                a.appendChild(i);
                serviceLinks.appendChild(a);
            }
        });
        li.appendChild(serviceLinks);
        trackListEl.appendChild(li);

        // if this index was recently uploaded, auto-open the inline editor
        if (window._openLinkEditors && Array.isArray(window._openLinkEditors)) {
            const pos = window._openLinkEditors.indexOf(index);
            if (pos >= 0) {
                // simulate click to open editor
                try { editLinksBtn.click(); } catch (e) {}
                window._openLinkEditors.splice(pos, 1);
            }
        }
    });

    // attach drag listeners
    trackListEl.querySelectorAll('li[draggable="true"]').forEach(li => {
        li.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', li.dataset.index);
            li.classList.add('dragging');
        });
        li.addEventListener('dragend', () => {
            li.classList.remove('dragging');
        });
    });

    // global dragover and drop handlers are attached once below
}

// handle file uploads
// Metadata extraction using jsmediatags (if available)
function extractMetadata(file) {
    return new Promise((resolve) => {
        const result = { title: null, artist: null, picture: null };
        if (window.jsmediatags && typeof window.jsmediatags.read === 'function') {
            try {
                window.jsmediatags.read(file, {
                    onSuccess: function(tag) {
                        const tags = tag.tags || {};
                        result.title = tags.title || null;
                        result.artist = tags.artist || null;
                        if (tags.picture) {
                            const picture = tags.picture;
                            let base64 = "";
                            for (let i = 0; i < picture.data.length; i++) {
                                base64 += String.fromCharCode(picture.data[i]);
                            }
                            try {
                                const dataUrl = `data:${picture.format};base64,${btoa(base64)}`;
                                result.picture = dataUrl;
                            } catch (e) {
                                result.picture = null;
                            }
                        }
                        resolve(result);
                    },
                    onError: function(err) {
                        resolve(result);
                    }
                });
            } catch (e) {
                resolve(result);
            }
        } else {
            // no library available
            resolve(result);
        }
    });
}

async function handleFiles(files) {
    isSaving = true;
    try {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (uploadStatusEl) uploadStatusEl.innerHTML = `<span class="spinner"></span>Processing ${i+1}/${files.length}`;
            if (!file.type.startsWith('audio/')) continue;

        // extract tags (title/artist/cover)
        const meta = await extractMetadata(file);

        // read file as data URL for playback & persistence
        const url = await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload = (e) => res(e.target.result);
            reader.onerror = rej;
            reader.readAsDataURL(file);
        });

        const title = meta.title || file.name.replace(/\.[^.]+$/, '');
        const artist = meta.artist || 'Unknown';

        // try to determine actual duration from the audio data
        let durationLabel = '0:00';
        try {
            const audioEl = new Audio();
            audioEl.src = url;
            const dur = await new Promise((res, rej) => {
                const onLoaded = () => { res(audioEl.duration); cleanup(); };
                const onError = () => { rej(new Error('duration failed')); cleanup(); };
                function cleanup() { audioEl.removeEventListener('loadedmetadata', onLoaded); audioEl.removeEventListener('error', onError); }
                audioEl.addEventListener('loadedmetadata', onLoaded);
                audioEl.addEventListener('error', onError);
            });
            if (isFinite(dur) && dur > 0) durationLabel = formatTime(dur);
        } catch (e) {
            // ignore, leave as 0:00
        }

        const newTrack = {
            id: window.tracks ? window.tracks.length + 1 : 1,
            title: title,
            artist: artist,
            duration: durationLabel,
            durationSeconds: isFinite(durationLabel) ? undefined : undefined,
            preview: url,
            cover: meta.picture || null,
            spotify: "",
            appleMusic: "",
            youtube: "",
            boomplay: "",
            audiomack: "",
        };

        if (!window.tracks) window.tracks = [];
        window.tracks.push(newTrack);
        // mark this newly added track to open the inline links editor after render
        window._openLinkEditors = window._openLinkEditors || [];
        window._openLinkEditors.push(window.tracks.length - 1);
    }

    if (uploadStatusEl) uploadStatusEl.textContent = '';
    await saveStoredTracks();
    // try to fill service links for newly-added tracks
    if (typeof autoDiscoverLinks === 'function') {
        await autoDiscoverLinks();
        // re-save in case new links were added
        await saveStoredTracks();
    }
    renderTracks();
    } finally {
        isSaving = false;
    }
}

// Auto-discover Spotify and YouTube links
async function discoverSpotifyLink(title, artist) {
    if (!title || !artist) return null;
    try {
        const query = encodeURIComponent(`${title} ${artist}`);
        // Spotify search link (no auth required)
        return `https://open.spotify.com/search/${query}`;
    } catch (e) {
        return null;
    }
}

async function discoverYoutubeLink(title, artist) {
    if (!title || !artist) return null;
    try {
        const query = encodeURIComponent(`${title} ${artist}`);
        // YouTube search link (no auth required)
        return `https://www.youtube.com/results?search_query=${query}`;
    } catch (e) {
        return null;
    }
}

async function discoverAppleMusicLink(title, artist) {
    if (!title || !artist) return null;
    try {
        const query = encodeURIComponent(`${title} ${artist}`);
        // Apple Music search link (no auth required)
        return `https://music.apple.com/search?term=${query}`;
    } catch (e) {
        return null;
    }
}

async function discoverBoomplayLink(title, artist) {
    if (!title || !artist) return null;
    try {
        const query = encodeURIComponent(`${title} ${artist}`);
        //Boomplay Music search link (no auth required)
        return `https://www.boomplay.com/search/${query}`;
    } catch (e) {
        return null;
    }
}
async function discoverAudiomackLink(title, artist) {
    if (!title || !artist) return null;
    try {
        const query = encodeURIComponent(`${title} ${artist}`);
        //Audiomack Music search link (no auth required)
        return `https://www.audiomack.com/search?q=${query}`;
    } catch (e) {
        return null;
    }
}

// Auto-discover links for all tracks missing them
async function autoDiscoverLinks() {
    if (!window.tracks || !window.tracks.length) return;
    let changed = false;
    for (const t of window.tracks) {
        if (!t || !t.title || !t.artist) continue;
        // youtube
        if (!t.youtube) {
            const yt = await discoverYoutubeLink(t.title, t.artist);
            if (yt) { t.youtube = yt; changed = true; }
        }
        // spotify
        if (!t.spotify) {
            const sp = await discoverSpotifyLink(t.title, t.artist);
            if (sp) { t.spotify = sp; changed = true; }
        }
        // apple music
        if (!t.appleMusic) {
            const am = await discoverAppleMusicLink(t.title, t.artist);
            if (am) { t.appleMusic = am; changed = true; }
        }
        // boomplay
        if (!t.boomplay) {
            const bp = await discoverBoomplayLink(t.title, t.artist);
            if (bp) { t.boomplay = bp; changed = true; }
        }
        // audiomack
        if (!t.audiomack) {
            const am = await discoverAudiomackLink(t.title, t.artist);
            if (am) { t.audiomack = am; changed = true; }
        }   
    }
    if (changed) await saveStoredTracks();
}

// Attempt to compute and fill missing durations for stored tracks.
async function fillMissingDurations() {
    if (!window.tracks || !window.tracks.length) return;
    let changed = false;
    const timeoutMs = 5000;
    for (let i = 0; i < window.tracks.length; i++) {
        const t = window.tracks[i];
        if (!t || !t.preview) continue;
        if (t.duration && t.duration !== '0:00') continue;
        try {
            const audio = new Audio();
            audio.src = t.preview;
            // race loadedmetadata against a timeout
            const dur = await Promise.race([
                new Promise((res, rej) => {
                    const onLoaded = () => {
                        cleanup();
                        res(audio.duration);
                    };
                    const onError = () => {
                        cleanup();
                        rej(new Error('failed to load'));
                    };
                    function cleanup() {
                        audio.removeEventListener('loadedmetadata', onLoaded);
                        audio.removeEventListener('error', onError);
                    }
                    audio.addEventListener('loadedmetadata', onLoaded);
                    audio.addEventListener('error', onError);
                }),
                new Promise((res, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
            ]);
            if (isFinite(dur) && dur > 0) {
                t.duration = formatTime(dur);
                changed = true;
            }
        } catch (e) {
            // ignore individual failures
        }
    }
    if (changed) await saveStoredTracks();
}

if (fileInput) {
    fileInput.addEventListener('change', async (event) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        await handleFiles(files);
        fileInput.value = '';
    });
}

// drag and drop support
if (uploadContainer) {
    uploadContainer.addEventListener('dragover', (e) => { e.preventDefault(); uploadContainer.classList.add('drag-over'); });
    uploadContainer.addEventListener('dragleave', () => { uploadContainer.classList.remove('drag-over'); });
    uploadContainer.addEventListener('drop', async (e) => {
        e.preventDefault();
        uploadContainer.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        await handleFiles(files);
    });
}

// handle manual cover selection
if (coverPicker) {
    coverPicker.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) return;
        const url = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = (ev) => res(ev.target.result);
            r.onerror = rej;
            r.readAsDataURL(file);
        });
        const idx = parseInt(coverPicker.dataset.targetIndex, 10);
        if (!Number.isNaN(idx) && window.tracks && window.tracks[idx]) {
            window.tracks[idx].cover = url;
            await saveStoredTracks();
            renderTracks();
        }
        coverPicker.value = '';
        delete coverPicker.dataset.targetIndex;
    });
}

// export playlist as JSON file
if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
        await saveStoredTracks(); // ensure latest saved
        const data = JSON.stringify(window.tracks || [], null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'playlist.json';
        a.click();
    });
}

// import playlist from JSON
if (importBtn && importInput) {
    importBtn.addEventListener('click', () => {
        importInput.click();
    });
    importInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const imported = JSON.parse(ev.target.result);
                if (Array.isArray(imported)) {
                    const urls = new Set((window.tracks || []).map(t => t.preview));
                    imported.forEach(t => {
                        if (t && t.preview && !urls.has(t.preview)) {
                            window.tracks.push(t);
                            urls.add(t.preview);
                        }
                    });
                    await saveStoredTracks();
                    renderTracks();
                    alert('Playlist imported.');
                } else {
                    alert('Invalid playlist file.');
                }
            } catch (err) {
                console.error(err);
                alert('Error reading playlist.');
            }
        };
        reader.readAsText(file);
        importInput.value = '';
    });
}

// clear playlist completely
if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
        if (confirm('Remove all tracks from the playlist?')) {
            window.tracks = [];
            await saveStoredTracks();
            renderTracks();
            if (typeof currentSound !== 'undefined' && currentSound) currentSound.stop();
            currentIndex = null;
            if (globalPlayer) globalPlayer.classList.add('hidden');
        }
    });
}

// initialize from storage (IndexedDB) and render
(async function init() {
    await loadStoredTracks();
    console.log('loaded', (window.tracks||[]).length, 'tracks from storage');
    // try to fill missing durations (for uploaded files that didn't report metadata earlier)
    await fillMissingDurations();
    // auto-discover Spotify and YouTube links
    await autoDiscoverLinks();
    renderTracks();
})();

