const globalPlayer = document.getElementById("globalPlayer");
const playerTitle = document.getElementById("playerTitle");
const playerArtist = document.getElementById("playerArtist");
const globalPlayBtn = document.getElementById("global");
const progressBar = document.getElementById("progressBar");
const currentTimeEl = document.getElementById("currentTime");
const totalTime = document.getElementById("totalTime");

let currentSound = null;
let currentIndex = null;

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

function updateProgress() {
    if (!currentSound || !currentSound.playing()) return;
    const seek = currentSound.seek() || 0;
    const duration = currentSound.duration() || 0;
    if (duration > 0) {
        progressBar.value = (seek / duration) * 100;
        currentTimeEl.textContent = formatTime(seek);
        totalTime.textContent = formatTime(duration);
    }
    requestAnimationFrame(updateProgress);
}

function playTrackByIndex(index) {
    if (!window.tracks || !window.tracks[index]) return console.warn("Track not found:", index);

    if (currentSound) {
        currentSound.stop();
    }

    currentIndex = index;
    const track = window.tracks[index];

    currentSound = new Howl({
        src: [track.preview],
        html5: true,

        onplay: () => {
            if (globalPlayer) globalPlayer.classList.remove("hidden");
            if (playerTitle) playerTitle.textContent = track.title;
            if (playerArtist) playerArtist.textContent = track.artist;
            if (globalPlayBtn) globalPlayBtn.textContent = "⏸";
            if (totalTime) totalTime.textContent = formatTime(currentSound.duration());
            requestAnimationFrame(updateProgress);
        },

        onend: () => {
            playNext();
        },

        onloaderror: (id, err) => {
            console.error("Audio load error", id, err, track.preview);
        },

        onplayerror: (id, err) => {
            console.error("Audio play error", id, err);
        }
    });
  
    currentSound.play();
}

function playNext() {
    if (currentIndex === null) return;

    let nextIndex = currentIndex + 1;
    if (!window.tracks || nextIndex >= window.tracks.length) {
        if (globalPlayBtn) globalPlayBtn.textContent = "▶";
        return;
    }

    progressBar.value = 0;
    playTrackByIndex(nextIndex);
}

function playPrevious() {
    if (currentIndex === null) return;
    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) prevIndex = 0;
    progressBar.value = 0;
    playTrackByIndex(prevIndex);
}

// Controls
const nextBtn = document.getElementById("nextBtn");
const prevBtn = document.getElementById("prevBtn");

if (nextBtn) nextBtn.addEventListener("click", playNext);
if (prevBtn) prevBtn.addEventListener("click", playPrevious);

if (globalPlayBtn) {
    globalPlayBtn.addEventListener("click", () => {
        if (!currentSound) return;
        if (currentSound.playing()) {
            currentSound.pause();
            globalPlayBtn.textContent = "▶";
        } else {
            currentSound.play();
            globalPlayBtn.textContent = "⏸";
            requestAnimationFrame(updateProgress);
        }
    });
}

if (progressBar) {
    progressBar.addEventListener("input", () => {
        if (!currentSound) return;
        const duration = currentSound.duration() || 0;
        const newTime = (progressBar.value / 100) * duration;
        currentSound.seek(newTime);
    });
}