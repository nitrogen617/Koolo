const canvas = document.getElementById('map');
const ctx = (canvas instanceof HTMLCanvasElement) ? canvas.getContext('2d') : null;
const meta = document.getElementById('meta');
const legend = document.getElementById('legend');
const legendItems = document.getElementById('legend-items');
const legendToggle = document.getElementById('legend-toggle');
const hud = document.getElementById('hud');
const hover = document.getElementById('hover');
const footer = document.getElementById('footer');
const stats = document.getElementById('stats');
const pauseButton = document.getElementById('toggle-pause');
const rewindSlider = document.getElementById('rewind');
const rewindLabel = document.getElementById('rewind-label');
if (canvas instanceof HTMLCanvasElement) {
  canvas.width = 720;
  canvas.height = 500;
}
const tileColors = {
  0: '#5c2a2d',
  1: '#0e1c23',
  2: '#0c8a16',
  3: '#c62828',
  4: '#ff8f00',
  5: '#593a78',
  6: '#ff0000',
  7: '#ffffff'
};
function tileColor(type) {
  return Object.prototype.hasOwnProperty.call(tileColors, type)
    ? tileColors[type]
    : '#0e1c23';
}
function renderLegend() {
  const entries = [
    { label: 'Walkable', color: tileColors[1] },
    { label: 'Low priority', color: tileColors[2] },
    { label: 'Non-walkable', color: tileColors[0] },
    { label: 'Thickened wall', color: tileColors[6] },
    { label: 'Diagonal tile', color: tileColors[7] },
    { label: 'Teleport over', color: tileColors[5] },
    { label: 'Doors', color: '#ab47bc' },
    { label: 'Portals', color: '#00c853', shape: 'circle' },
    { label: 'Entrances', color: '#ffa000' },
    { label: 'Objects', color: '#ffeb3b' },
    { label: 'Monsters', color: '#ff7043', shape: 'circle' },
    { label: 'Navigation path', color: '#00bcd4', shape: 'line' },
    { label: 'Player', color: '#00e5ff', shape: 'circle' }
  ];
  const host = legendItems || legend;
  if (host) {
    host.innerHTML = entries
      .map((entry) => {
        const shape = entry.shape || 'square';
        return `<div class="legend-item"><span class="legend-swatch ${shape}" style="--legend-color:${entry.color};"></span>${entry.label}</div>`;
      })
      .join('');
  }
}
renderLegend();

let isPaused = false;
let pausedAt = 0;
let history = [];
const historyWindowMs = 60000;
let isLegendHidden = false;
if (pauseButton) {
  pauseButton.addEventListener('click', () => {
    isPaused = !isPaused;
    pauseButton.textContent = isPaused ? 'Overlay: Paused' : 'Overlay: Live';
    pausedAt = isPaused ? Date.now() : 0;
    if (rewindSlider) {
      rewindSlider.disabled = !isPaused;
      rewindSlider.value = '0';
    }
    if (rewindLabel) {
      rewindLabel.textContent = isPaused ? 'Rewind: 0s' : 'Rewind: Live';
    }
    if (!isPaused && history.length > 0) {
      update(history[history.length - 1].payload);
    }
  });
}
if (legendToggle && legend) {
  legendToggle.addEventListener('click', () => {
    isLegendHidden = !isLegendHidden;
    if (legendItems) {
      if (isLegendHidden) {
        legendItems.classList.add('hidden');
        legendToggle.textContent = 'Show';
      } else {
        legendItems.classList.remove('hidden');
        legendToggle.textContent = 'Hide';
      }
    }
    resizeCanvas();
    update(latestPayload);
  });
}
if (rewindSlider) {
  rewindSlider.addEventListener('input', () => {
    if (!isPaused) return;
    const seconds = Number(rewindSlider.value) || 0;
    if (rewindLabel) {
      rewindLabel.textContent = seconds === 0 ? 'Rewind: 0s' : `Rewind: ${seconds}s`;
    }
    renderFromHistory(seconds);
  });
}

function resizeCanvas() {
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const maxWidth = 720;
  const horizontalPadding = 16;
  const availableWidth = Math.max(
    320,
    Math.min(maxWidth, window.innerWidth - horizontalPadding)
  );
  const legendHeight = legend ? legend.getBoundingClientRect().height : 0;
  const hudHeight = hud ? hud.getBoundingClientRect().height : 0;
  const verticalPadding = 24;
  const availableHeight = Math.max(
    200,
    window.innerHeight - legendHeight - hudHeight - verticalPadding
  );

  canvas.width = Math.floor(availableWidth);
  canvas.height = Math.floor(availableHeight);
}

resizeCanvas();
window.addEventListener('resize', () => {
  resizeCanvas();
  update(latestPayload);
});

function asArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [];
}

function draw(payload) {
  if (!canvas || !ctx) return;
  ctx.fillStyle = '#050607';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let scale = typeof payload.scale === 'number' ? payload.scale : 3;
  let originX = canvas.width / 2;
  let originY = canvas.height / 2;

  asArray(payload.tiles).forEach((tile) => {
    ctx.fillStyle = tileColor(tile.type);
    const baseSize = Math.max(1, scale);
    const size = tile.type === 0 || tile.type === 5 || tile.type === 6
      ? Math.max(baseSize, 2)
      : Math.max(1, baseSize - 0.5);
    ctx.fillRect(originX + tile.x * scale - size / 2, originY + tile.y * scale - size / 2, size, size);
  });

  const pathPoints = asArray(payload.path);
  if (pathPoints.length > 1) {
    ctx.strokeStyle = '#00bcd4';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    pathPoints.forEach((pt, idx) => {
      const px = originX + pt.x * scale;
      const py = originY + pt.y * scale;
      if (idx === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    });
    ctx.stroke();
    ctx.fillStyle = '#00bcd4';
    pathPoints.forEach((pt) => {
      ctx.fillRect(originX + pt.x * scale - 2.5, originY + pt.y * scale - 2.5, 5, 5);
    });
  }

  ctx.fillStyle = '#ab47bc';
  asArray(payload.doors).forEach((door) => {
    const size = door.size || 4;
    ctx.fillRect(originX + door.x * scale - size / 2, originY + door.y * scale - size / 2, size, size);
  });

  ctx.fillStyle = '#00c853';
  asArray(payload.portals).forEach((portal) => {
    const radius = portal.size || 4;
    ctx.beginPath();
    ctx.arc(originX + portal.x * scale, originY + portal.y * scale, radius, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = '#ffa000';
  asArray(payload.entrances).forEach((ent) => {
    const size = ent.size || 4;
    const px = originX + ent.x * scale;
    const py = originY + ent.y * scale;
    ctx.beginPath();
    ctx.moveTo(px, py - size);
    ctx.lineTo(px + size, py);
    ctx.lineTo(px, py + size);
    ctx.lineTo(px - size, py);
    ctx.closePath();
    ctx.fill();
  });

  ctx.fillStyle = '#ffeb3b';
  asArray(payload.objects).forEach((obj) => {
    ctx.fillRect(originX + obj.x * scale - 2, originY + obj.y * scale - 2, 4, 4);
  });

  ctx.fillStyle = '#ff7043';
  asArray(payload.monsters).forEach((mon) => {
    ctx.beginPath();
    ctx.arc(originX + mon.x * scale, originY + mon.y * scale, mon.size || 3, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = '#00e5ff';
  ctx.beginPath();
  ctx.arc(originX, originY, 4.5, 0, Math.PI * 2);
  ctx.fill();

  if (payload.meta && meta) {
    meta.textContent = ' ' + payload.meta;
  }
  if (stats) {
    const parts = [];
    if (payload.player) parts.push(payload.player);
    if (payload.target) parts.push(payload.target);
    if (payload.pathLen) parts.push(`Path: ${payload.pathLen}`);
    if (payload.lastAction) parts.push(`Action: ${payload.lastAction}`);
    if (payload.lastStep) parts.push(`Step: ${payload.lastStep}`);
    stats.textContent = parts.length ? ' ' + parts.join(' | ') : '';
    stats.style.display = parts.length ? 'block' : 'none';
  }
  if (hover) {
    hover.textContent = payload.hover ? ' ' + payload.hover : '';
    hover.style.display = payload.hover ? 'block' : 'none';
  }
  if (footer) {
    footer.textContent = payload.footer ? ' ' + payload.footer : '';
    footer.style.display = payload.footer ? 'block' : 'none';
  }
}

let latestPayload = null;
let ticking = false;

function update(payload) {
  latestPayload = payload || {};
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(() => {
      draw(latestPayload);
      ticking = false;
    });
  }
}

function pushHistory(payload) {
  const now = Date.now();
  history.push({ t: now, payload });
  while (history.length > 0 && now-history[0].t > historyWindowMs) {
    history.shift();
  }
}

function renderFromHistory(seconds) {
  if (history.length === 0) return;
  const target = pausedAt - seconds * 1000;
  let chosen = history[0].payload;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].t <= target) {
      chosen = history[i].payload;
      break;
    }
  }
  update(chosen);
}

function poll() {
  if (!isPaused) {
    fetch(`/data`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((payload) => {
        pushHistory(payload);
        update(payload);
      })
      .catch((err) => {
        if (meta) meta.textContent = ' Error: ' + err.message;
      });
  }

  setTimeout(poll, 100);
}

poll();
