"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const playwright_1 = require("playwright");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const OUTPUT_DIR = path.join(__dirname, 'output');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = path.join(OUTPUT_DIR, `run-${RUN_ID}`);
const SESSION_FILE = path.join(OUTPUT_DIR, 'session.json'); // cookies persistés entre runs
const RECORDS_DIR = path.join(OUTPUT_DIR, 'records'); // stocke les séquences rejouables
const NETWORK_LOG = path.join(RUN_DIR, 'network.log');
const ACTION_LOG = path.join(RUN_DIR, 'actions.log');
let isRecording = false;
let currentRecordName = null;
let recordStartTs = 0;
let currentRecordEvents = [];
let recordFinished = null;
let screenshotCounter = 0;
let overlayPage = null;
const randomDelay = (min, max) => new Promise((resolve) => setTimeout(resolve, Math.random() * (max - min) + min));
const appendLine = (filePath, line, _alsoConsole = false) => {
    // Pas de log console pour éviter EPIPE; tout va dans les fichiers.
    fs.appendFileSync(filePath, line + '\n', { encoding: 'utf-8' });
    // Pousser la ligne vers l'overlay s'il existe (best effort, non bloquant)
    if (overlayPage) {
        overlayPage
            .evaluate((msg) => {
            // @ts-ignore
            if (typeof window.__overlayLog === 'function') {
                // @ts-ignore
                window.__overlayLog(msg);
            }
        }, line)
            .catch(() => {
            /* ignore overlay errors */
        });
    }
};
const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath))
        fs.mkdirSync(dirPath, { recursive: true });
};
const sanitizeName = (name) => {
    const base = (name || 'record').trim() || 'record';
    return base.replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 80);
};
const saveCurrentRecord = () => {
    if (!currentRecordName || !currentRecordEvents.length)
        return null;
    ensureDir(RECORDS_DIR);
    const safeName = sanitizeName(currentRecordName);
    const filePath = path.join(RECORDS_DIR, `${safeName}-${recordStartTs}.json`);
    const record = {
        name: currentRecordName,
        startedAt: new Date(recordStartTs).toISOString(),
        durationMs: Date.now() - recordStartTs,
        events: currentRecordEvents,
        runDir: RUN_DIR
    };
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), { encoding: 'utf-8' });
    return filePath;
};
const loadRecordByName = (name) => {
    if (!fs.existsSync(RECORDS_DIR))
        return null;
    const files = fs.readdirSync(RECORDS_DIR).filter((f) => f.endsWith('.json'));
    let best = null;
    for (const file of files) {
        try {
            const full = path.join(RECORDS_DIR, file);
            const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
            if (!data?.name || !Array.isArray(data.events))
                continue;
            if (data.name.toLowerCase() !== name.toLowerCase())
                continue;
            const ts = new Date(data.startedAt).getTime() || 0;
            if (!best || ts > best.ts) {
                best = { record: data, file: full, ts };
            }
        }
        catch {
            /* ignore malformed */
        }
    }
    return best ? { record: best.record, file: best.file } : null;
};
const setProxyStatusOverlay = (page, text, tone) => {
    if (!page)
        return;
    page
        .evaluate((payload) => {
        // @ts-ignore
        if (typeof window.__setProxyStatus === 'function') {
            // @ts-ignore
            window.__setProxyStatus(payload.text, payload.tone);
        }
    }, { text, tone })
        .catch(() => { });
};
const performEvent = async (page, ev) => {
    const target = page.locator(ev.selector).first();
    try {
        if (['click', 'mousedown'].includes(ev.type)) {
            await target.click({ timeout: 5000 });
        }
        else if (['input', 'change', 'keydown'].includes(ev.type)) {
            await target.fill(ev.value || '', { timeout: 5000 });
        }
        else if (ev.type === 'mousemove' && ev.value) {
            const match = /x=(\d+)\s*y=(\d+)/i.exec(ev.value);
            if (match) {
                await page.mouse.move(Number(match[1]), Number(match[2]));
            }
        }
        else {
            await target.click({ timeout: 5000 });
        }
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION record.replay.event ok type=${ev.type} selector=${ev.selector}`);
    }
    catch (err) {
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION record.replay.event failed type=${ev.type} selector=${ev.selector} err=${String(err)}`);
    }
};
const replayRecord = async (page, name) => {
    if (!page) {
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION record.replay.error no active page`);
        return;
    }
    const targetName = sanitizeName(name || currentRecordName || 'record');
    const loaded = loadRecordByName(targetName);
    if (!loaded) {
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION record.replay.error not_found name=${targetName}`);
        return;
    }
    appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION record.replay.start name=${loaded.record.name} events=${loaded.record.events.length} file=${loaded.file}`);
    let lastAt = 0;
    for (const ev of loaded.record.events) {
        const wait = Math.max(0, ev.at - lastAt);
        if (wait > 0) {
            await page.waitForTimeout(Math.min(wait, 5000)); // limiter pour ne pas attendre trop longtemps
        }
        lastAt = ev.at;
        await performEvent(page, ev);
    }
    appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION record.replay.end name=${loaded.record.name}`);
};
const getUserAgent = () => {
    const versions = ['120.0.0.0', '119.0.0.0', '121.0.0.0'];
    const version = versions[Math.floor(Math.random() * versions.length)];
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
};
const getHeaders = () => ({
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    Dnt: '1'
});
const isCaptchaPage = async (page) => {
    const url = page.url().toLowerCase();
    if (url.includes('captcha-delivery') || url.includes('ct.captcha') || url.includes('datadome')) {
        return true;
    }
    return page.evaluate(() => {
        return (document.body.textContent?.toLowerCase().includes('datadome') ||
            document.body.textContent?.toLowerCase().includes('captcha') ||
            document.querySelector('iframe[src*="captcha"]') !== null);
    });
};
const parseProxyLine = (line) => {
    const parts = line.trim().split(':');
    if (parts.length < 4)
        return null;
    const [host, port, username, password] = parts;
    if (!host || !port || !username || !password)
        return null;
    return {
        server: `http://${host}:${port}`,
        username,
        password
    };
};
const loadProxyPool = (proxyListPath) => {
    if (!proxyListPath || !fs.existsSync(proxyListPath))
        return [];
    const lines = fs.readFileSync(proxyListPath, 'utf-8').split('\n').filter(Boolean);
    return lines
        .map(parseProxyLine)
        .filter((p) => Boolean(p));
};
function pickProxy(config) {
    const pool = loadProxyPool(config.proxyListPath || path.join(__dirname, 'iproyal-proxies.txt'));
    if (config.useProxyPool !== false && pool.length > 0) {
        const proxy = pool[Math.floor(Math.random() * pool.length)];
        return { proxy, source: `pool(${pool.length})` };
    }
    if (config.proxy) {
        return { proxy: config.proxy, source: 'config' };
    }
    if (pool.length > 0) {
        const proxy = pool[0];
        return { proxy, source: `pool(${pool.length})` };
    }
    throw new Error('Aucun proxy disponible (config ou proxyListPath)');
}
async function warmupSession(page) {
    appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION warmup.start`);
    try {
        await page.goto('https://www.seloger.com/?tab=buy', {
            waitUntil: 'domcontentloaded',
            timeout: 45000
        });
        await randomDelay(2000, 4000);
        await page.evaluate(() => window.scrollBy(0, 300));
        await randomDelay(1000, 2000);
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION warmup.done`);
    }
    catch (error) {
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION warmup.error ${String(error)}`);
    }
}
async function logPublicIp(context) {
    try {
        const ipPage = await context.newPage();
        await ipPage.goto('https://ipv4.icanhazip.com', {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });
        const ipText = (await ipPage.textContent('body'))?.trim();
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] IP icanhazip=${ipText || 'inconnue'}`);
        setProxyStatusOverlay(overlayPage, `proxy OK: ${ipText || 'inconnue'}`, 'ok');
        await ipPage.close();
        return Boolean(ipText);
    }
    catch (err) {
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] IP check failed: ${String(err)}`);
        setProxyStatusOverlay(overlayPage, 'proxy: IP check failed', 'error');
        return false;
    }
}
async function navigateToSearch(page, zoneCode, pageNumber) {
    const searchUrl = `https://www.seloger.com/classified-search?distributionTypes=Buy&estateTypes=Apartment&locations=${zoneCode}&page=${pageNumber}`;
    appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION goto.search url=${searchUrl}`);
    try {
        const response = await page.goto(searchUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        if (response && (response.status() === 403 || response.status() === 429)) {
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] Navigation blocked status=${response.status()}`);
            return false;
        }
        await randomDelay(3000, 5000);
        const isBlocked = await page.evaluate(() => {
            return (document.body.textContent?.toLowerCase().includes('datadome') ||
                document.body.textContent?.toLowerCase().includes('captcha') ||
                document.querySelector('iframe[src*="captcha"]') !== null ||
                window.location.href.includes('captcha-delivery'));
        });
        if (isBlocked) {
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] Navigation blocked: captcha detected`);
            await page.screenshot({
                path: path.join(RUN_DIR, 'blocked.png'),
                fullPage: true
            });
            return false;
        }
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] Navigation OK`);
        return true;
    }
    catch (error) {
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] Navigation error: ${String(error)}`);
        return false;
    }
}
async function selectZoneViaUi(page, zoneCode) {
    appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION ui.selectZone start (${zoneCode})`);
    const searchSelectors = [
        'div.css-1uyzezs', // bouton loupe / nouvelle recherche observé
        'input[placeholder*="Ville"]',
        'input[placeholder*="localisation"]',
        'input[placeholder*="Où"]',
        'input[type="search"]',
        'input[data-testid="search-input"]'
    ];
    try {
        // Ouvrir une nouvelle recherche si un bouton est présent
        const newSearchButton = await page.$('text=Créer une nouvelle recherche');
        if (newSearchButton) {
            await newSearchButton.click();
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION ui.click new search button (Créer une nouvelle recherche)`);
            await randomDelay(1000, 2000);
        }
    }
    catch {
        /* ignore */
    }
    for (const sel of searchSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 3000 });
            await page.click(sel);
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION ui.click selector=${sel} to type zone`);
            // Dans certains cas le selecteur est un bouton, on tente de trouver le champ adjacent
            const inputHandle = await page.$('input[placeholder*="Ville"], input[placeholder*="localisation"], input[placeholder*="Où"], input[type="search"], input[data-testid="search-input"]');
            const targetForType = inputHandle || (await page.$(sel));
            if (!targetForType)
                continue;
            await targetForType.fill('');
            await targetForType.type(zoneCode, { delay: 120 + Math.random() * 80 });
            await randomDelay(800, 1500);
            // Sélectionner la bonne suggestion
            const picked = await page.evaluate((code) => {
                const textMatch = (t) => t.toLowerCase().includes(code.toLowerCase()) ||
                    t.toLowerCase().includes('paris 15') ||
                    t.toLowerCase().includes('75015');
                const candidates = Array.from(document.querySelectorAll('[role="option"], li[role="option"], div[role="option"], [data-testid*="suggestion"], li'));
                for (const c of candidates) {
                    const txt = c.innerText || c.textContent || '';
                    if (textMatch(txt)) {
                        c.click();
                        return { clicked: true, text: txt };
                    }
                }
                return { clicked: false, text: '' };
            }, zoneCode);
            if (picked.clicked) {
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION ui.select suggestion="${picked.text}"`);
            }
            else {
                await page.keyboard.press('Enter');
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION ui.press Enter after typing`);
            }
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
            return true;
        }
        catch {
            continue;
        }
    }
    appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION ui.selectZone failed: no selector matched`, true);
    return false;
}
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 200;
            let scrollCount = 0;
            const maxScrolls = 15;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                scrollCount++;
                if (totalHeight >= scrollHeight || scrollCount >= maxScrolls) {
                    clearInterval(timer);
                    resolve();
                }
            }, 300);
        });
    });
    await randomDelay(2000, 3000);
}
async function extractListings(page) {
    appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION extraction.start`);
    try {
        await randomDelay(1000, 2000);
        await page.mouse.move(300 + Math.random() * 200, 200 + Math.random() * 200, { steps: 12 });
        await page.waitForSelector('[id^="classified-card-"]', {
            timeout: 20000,
            state: 'visible'
        });
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION extraction.cards.visible`);
        await autoScroll(page);
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION extraction.scroll.done`);
        const urls = await page.evaluate(() => {
            const uniqueUrls = new Set();
            const cards = document.querySelectorAll('[id^="classified-card-"]');
            cards.forEach((card) => {
                const links = card.querySelectorAll('a[href]');
                links.forEach((link) => {
                    const href = link.href;
                    if (href.includes('/annonces/achat/appartement/') ||
                        (href.includes('bellesdemeures.com/') && href.includes('/detail.htm'))) {
                        const cleanUrl = href.split('?')[0].split('#')[0];
                        uniqueUrls.add(cleanUrl);
                    }
                });
            });
            return Array.from(uniqueUrls);
        });
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION extraction.done count=${urls.length}`);
        return urls;
    }
    catch (error) {
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION extraction.error ${String(error)}`);
        await page.screenshot({
            path: path.join(RUN_DIR, 'timeout.png'),
            fullPage: true
        });
        const html = await page.content();
        fs.writeFileSync(path.join(RUN_DIR, 'page.html'), html);
        throw error;
    }
}
function validateUrlsForZone(urls, zoneCode) {
    if (!urls.length)
        return { ok: false, ratio: 0 };
    const lowerZone = zoneCode.toLowerCase();
    const score = urls.filter((u) => {
        const lu = u.toLowerCase();
        return lu.includes(lowerZone) || lu.includes('paris-15') || lu.includes('75015');
    }).length;
    const ratio = score / urls.length;
    return { ok: ratio >= 0.6, ratio };
}
async function waitForManualAssistance(page, reason, ms = 30000) {
    appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION manual.assist.start reason=${reason} waitMs=${ms}`);
    try {
        const shotPath = path.join(RUN_DIR, `assist-${reason}-${Date.now()}.png`);
        await page.screenshot({ path: shotPath, fullPage: true }).catch(() => { });
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION manual.assist.screenshot path=${shotPath}`);
    }
    catch {
        /* ignore */
    }
    await page.waitForTimeout(ms);
    appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION manual.assist.end reason=${reason} elapsed=${ms}`);
}
async function injectRecordingUi(page) {
    // Insertion du panneau de contrôle + viewer de logs non bloquant
    try {
        await page.addInitScript(() => {
            const inject = () => {
                if (document.getElementById('__rec_panel'))
                    return;
                const panel = document.createElement('div');
                panel.id = '__rec_panel';
                panel.style.position = 'fixed';
                panel.style.bottom = '12px';
                panel.style.right = '12px';
                panel.style.zIndex = '2147483647';
                panel.style.background = 'rgba(0,0,0,0.6)';
                panel.style.padding = '6px 8px';
                panel.style.borderRadius = '6px';
                panel.style.fontSize = '12px';
                panel.style.color = '#fff';
                panel.style.display = 'flex';
                panel.style.gap = '4px';
                panel.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
                panel.style.pointerEvents = 'auto';
                const btn = (label, action, color) => {
                    const b = document.createElement('button');
                    b.textContent = label;
                    b.style.background = color;
                    b.style.color = '#fff';
                    b.style.border = 'none';
                    b.style.borderRadius = '4px';
                    b.style.padding = '4px 6px';
                    b.style.cursor = 'pointer';
                    return b;
                };
                const status = document.createElement('span');
                status.id = '__rec_status';
                status.textContent = 'idle';
                status.style.alignSelf = 'center';
                status.style.fontSize = '11px';
                status.style.padding = '2px 4px';
                status.style.background = 'rgba(255,255,255,0.1)';
                status.style.borderRadius = '4px';
                const startBtn = btn('Start rec', 'start', '#2d8f2d');
                startBtn.onclick = () => {
                    const name = prompt('Nom du record ?', '') || '';
                    const fallback = `record-${Date.now()}`;
                    const safeName = (name.trim() || fallback)
                        .replace(/[^a-zA-Z0-9-_]+/g, '_')
                        .slice(0, 80);
                    // @ts-ignore
                    window.playwrightRecordControl?.({ action: 'start', name: safeName });
                    status.textContent = `rec: ${safeName}`;
                    status.style.background = 'rgba(255,0,0,0.3)';
                    if (safeName) {
                        try {
                            const key = '__pw_records__';
                            const list = JSON.parse(localStorage.getItem(key) || '[]');
                            if (!list.includes(safeName)) {
                                list.push(safeName);
                                localStorage.setItem(key, JSON.stringify(list));
                            }
                        }
                        catch (e) {
                            console.error('record list save failed', e);
                        }
                    }
                };
                const stopBtn = btn('Stop rec', 'stop', '#b33a3a');
                stopBtn.onclick = () => {
                    // @ts-ignore
                    window.playwrightRecordControl?.({ action: 'stop' });
                    status.textContent = 'idle';
                    status.style.background = 'rgba(255,255,255,0.1)';
                };
                const dataBtn = btn('Data is here', 'data', '#1f6feb');
                dataBtn.onclick = () => {
                    // @ts-ignore
                    window.playwrightRecordControl?.({ action: 'data' });
                };
                const shotBtn = btn('Screenshot', 'screenshot', '#8a2be2');
                shotBtn.onclick = () => {
                    // @ts-ignore
                    window.playwrightRecordControl?.({ action: 'screenshot' });
                    // @ts-ignore
                    window.playwrightCaptureShot?.();
                };
                const playName = document.createElement('input');
                playName.id = '__rec_play_name';
                playName.placeholder = 'nom du record';
                playName.style.width = '120px';
                playName.style.fontSize = '11px';
                playName.style.padding = '4px';
                playName.style.borderRadius = '4px';
                playName.style.border = '1px solid rgba(255,255,255,0.2)';
                playName.style.background = 'rgba(0,0,0,0.2)';
                playName.style.color = '#fff';
                playName.style.outline = 'none';
                playName.style.flex = '1 1 auto';
                const playBtn = btn('Play rec', 'play', '#cc8800');
                playBtn.onclick = () => {
                    try {
                        const key = '__pw_records__';
                        const list = JSON.parse(localStorage.getItem(key) || '[]');
                        let picked = (playName.value || '').trim();
                        if (!picked) {
                            picked = prompt('Choisir le record à rejouer:\n' + list.join('\n'), list[0] || '') || '';
                        }
                        if (!picked && list.length > 0) {
                            picked = list[0];
                        }
                        if (!picked)
                            return;
                        playName.value = picked;
                        // @ts-ignore
                        window.playwrightRecordControl?.({ action: 'play', name: picked });
                    }
                    catch (e) {
                        console.error('record list read failed', e);
                    }
                };
                const clearBtn = btn('Clear cookies', 'clear', '#5555aa');
                clearBtn.onclick = () => {
                    // @ts-ignore
                    window.playwrightClearCookies?.();
                };
                panel.appendChild(startBtn);
                panel.appendChild(stopBtn);
                panel.appendChild(dataBtn);
                panel.appendChild(playName);
                panel.appendChild(playBtn);
                panel.appendChild(shotBtn);
                panel.appendChild(status);
                panel.appendChild(clearBtn);
                // Proxy toggle (affichage uniquement, requiert relance pour appliquer)
                const proxyToggle = document.createElement('label');
                proxyToggle.style.display = 'flex';
                proxyToggle.style.alignItems = 'center';
                proxyToggle.style.gap = '4px';
                proxyToggle.style.color = '#fff';
                proxyToggle.style.fontSize = '11px';
                proxyToggle.style.cursor = 'pointer';
                proxyToggle.style.marginLeft = '6px';
                const proxyCheckbox = document.createElement('input');
                proxyCheckbox.type = 'checkbox';
                proxyCheckbox.id = '__proxy_toggle';
                // état initial poussé depuis Node via __initialProxyEnabled (sinon true par défaut)
                // @ts-ignore
                proxyCheckbox.checked = (window.__initialProxyEnabled ?? true);
                proxyCheckbox.style.cursor = 'pointer';
                proxyCheckbox.onchange = () => {
                    // @ts-ignore
                    window.playwrightProxyToggle?.(proxyCheckbox.checked);
                };
                const proxyLabelText = document.createElement('span');
                proxyLabelText.textContent = proxyCheckbox.checked
                    ? 'Proxy ON (redémarrer pour appliquer)'
                    : 'Proxy OFF (redémarrer pour appliquer)';
                proxyToggle.appendChild(proxyCheckbox);
                proxyToggle.appendChild(proxyLabelText);
                panel.appendChild(proxyToggle);
                const proxyInfo = document.createElement('span');
                proxyInfo.id = '__proxy_status';
                proxyInfo.textContent = 'proxy: pending';
                proxyInfo.style.position = 'absolute';
                proxyInfo.style.top = '-18px';
                proxyInfo.style.right = '0';
                proxyInfo.style.background = 'rgba(0,0,0,0.5)';
                proxyInfo.style.padding = '2px 6px';
                proxyInfo.style.borderRadius = '4px';
                proxyInfo.style.fontSize = '11px';
                proxyInfo.style.pointerEvents = 'none';
                panel.appendChild(proxyInfo);
                document.body.appendChild(panel);
                // Log viewer (bottom-left, non bloquant)
                const logBox = document.createElement('div');
                logBox.id = '__rec_logs';
                logBox.style.position = 'fixed';
                logBox.style.bottom = '12px';
                logBox.style.left = '12px';
                logBox.style.zIndex = '2147483646';
                logBox.style.width = '360px';
                logBox.style.maxHeight = '200px';
                logBox.style.overflow = 'hidden';
                logBox.style.background = 'rgba(0,0,0,0.55)';
                logBox.style.color = '#d0d0d0';
                logBox.style.fontSize = '11px';
                logBox.style.lineHeight = '1.3';
                logBox.style.padding = '6px';
                logBox.style.borderRadius = '6px';
                logBox.style.boxShadow = '0 2px 6px rgba(0,0,0,0.25)';
                logBox.style.pointerEvents = 'none'; // n'interfère pas avec la page
                const logContent = document.createElement('div');
                logContent.id = '__rec_logs_content';
                logContent.style.display = 'flex';
                logContent.style.flexDirection = 'column';
                logContent.style.gap = '2px';
                logBox.appendChild(logContent);
                document.body.appendChild(logBox);
                // Helpers accessibles depuis playwright
                // @ts-ignore
                window.__overlayLog = (msg) => {
                    try {
                        const content = document.getElementById('__rec_logs_content');
                        if (!content)
                            return;
                        const line = document.createElement('div');
                        line.textContent = msg;
                        line.style.whiteSpace = 'pre';
                        content.appendChild(line);
                        while (content.childElementCount > 120) {
                            content.removeChild(content.firstChild);
                        }
                        logBox.scrollTop = logBox.scrollHeight;
                    }
                    catch (e) {
                        console.error('overlayLog fail', e);
                    }
                };
                // @ts-ignore
                window.__setProxyStatus = (txt, tone) => {
                    const el = document.getElementById('__proxy_status');
                    if (!el)
                        return;
                    el.textContent = txt;
                    if (tone === 'ok') {
                        el.style.background = 'rgba(34,139,34,0.6)';
                        el.style.color = '#e9ffe9';
                    }
                    else if (tone === 'warn') {
                        el.style.background = 'rgba(205,133,0,0.65)';
                        el.style.color = '#fff6e0';
                    }
                    else {
                        el.style.background = 'rgba(178,34,34,0.65)';
                        el.style.color = '#ffecec';
                    }
                };
                // @ts-ignore
                window.__setProxyToggleState = (enabled) => {
                    const cb = document.getElementById('__proxy_toggle');
                    if (!cb)
                        return;
                    cb.checked = !!enabled;
                };
            };
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                inject();
            }
            else {
                document.addEventListener('DOMContentLoaded', inject, { once: true });
            }
        });
    }
    catch {
        /* ignore */
    }
}
async function handleRequestLogging(req) {
    appendLine(NETWORK_LOG, `[${new Date().toISOString()}] Request ${req.method()} ${req.url()} frame=${req.frame()?.url() || 'n/a'} type=${req.resourceType()}`, false);
}
async function handleResponseLogging(res, suspected) {
    const url = res.url();
    appendLine(NETWORK_LOG, `[${new Date().toISOString()}] Response ${res.status()} ${res.request().method()} ${url}`, false);
    if (res.status() === 403 || res.status() === 429) {
        suspected.blocked = true;
    }
    if (url.includes('datadome') ||
        url.includes('fraud') ||
        url.includes('captcha-delivery') ||
        url.includes('ct.captcha')) {
        appendLine(NETWORK_LOG, `[${new Date().toISOString()}] DataDome/Fraud ${res.status()} ${res.request().method()} ${url}`);
    }
}
async function handleRequestFailedLogging(req, suspected) {
    appendLine(NETWORK_LOG, `[${new Date().toISOString()}] Request failed ${req.method()} ${req.url()} | ${req.failure()?.errorText || 'unknown'}`, false);
    if (req.url().includes('captcha') || req.url().includes('datadome')) {
        suspected.blocked = true;
    }
}
async function runRecorder(config) {
    const { proxy } = config;
    if (!fs.existsSync(OUTPUT_DIR))
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    if (!fs.existsSync(RUN_DIR))
        fs.mkdirSync(RUN_DIR, { recursive: true });
    let browser = null;
    let context = null;
    const suspected = { blocked: false };
    let mainPage = null;
    let proxyFailed = false;
    try {
        browser = await playwright_1.chromium.launch({
            headless: config.headless ?? false,
            proxy: proxy
                ? {
                    server: proxy.server,
                    username: proxy.username,
                    password: proxy.password
                }
                : undefined,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });
        context = await browser.newContext({
            userAgent: getUserAgent(),
            viewport: { width: 1920, height: 1080 },
            locale: 'fr-FR',
            timezoneId: 'Europe/Paris',
            extraHTTPHeaders: getHeaders(),
            permissions: ['geolocation'],
            geolocation: { latitude: 48.8566, longitude: 2.3522 },
            colorScheme: 'light',
            deviceScaleFactor: 1,
            storageState: fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined
        });
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            delete window.__playwright;
            delete window.__pw_manual;
            window.chrome = { runtime: {} };
        });
        // État initial du proxy côté page pour le toggle UI
        await context.addInitScript((enabled) => {
            // @ts-ignore
            window.__initialProxyEnabled = enabled;
        }, config.proxyEnabled !== false);
        await context.exposeBinding('logUserEvent', (_source, data) => {
            const payload = `[${new Date().toISOString()}] USER_EVENT type=${data.type} target=${data.target} value=${data.value || ''}`;
            appendLine(ACTION_LOG, payload, true);
            if (isRecording) {
                currentRecordEvents.push({
                    at: Date.now() - recordStartTs,
                    type: data.type,
                    selector: data.target,
                    value: data.value
                });
            }
        });
        await context.exposeBinding('playwrightRecordControl', async (_source, payload) => {
            const action = typeof payload === 'string' ? payload : payload?.action;
            const name = typeof payload === 'object' ? payload?.name : undefined;
            if (action === 'start') {
                currentRecordName = sanitizeName(name || `record-${new Date().toISOString()}`);
                isRecording = true;
                recordStartTs = Date.now();
                currentRecordEvents = [];
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION record.start name=${currentRecordName}`, true);
            }
            else if (action === 'stop') {
                isRecording = false;
                const savedPath = saveCurrentRecord();
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION record.stop saved=${savedPath || 'none'} events=${currentRecordEvents.length}`, true);
                currentRecordName = null;
                currentRecordEvents = [];
                recordFinished?.();
            }
            else if (action === 'data') {
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION marker.data_is_here`, true);
            }
            else if (action === 'screenshot') {
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION marker.screenshot.request`, true);
            }
            else if (action === 'play') {
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION record.play name=${name || 'unnamed'}`, true);
                await replayRecord(mainPage, name);
            }
            else {
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION record.unknown action=${action}`, true);
            }
        });
        await context.exposeBinding('playwrightClearCookies', async () => {
            try {
                await context?.clearCookies();
                for (const p of context?.pages() || []) {
                    try {
                        await p.evaluate(() => {
                            localStorage.clear();
                            sessionStorage.clear();
                            indexedDB.databases()?.then((dbs) => dbs.forEach((db) => indexedDB.deleteDatabase(db.name || '')));
                        });
                    }
                    catch {
                        /* ignore */
                    }
                }
                if (fs.existsSync(SESSION_FILE)) {
                    try {
                        fs.unlinkSync(SESSION_FILE);
                    }
                    catch {
                        /* ignore */
                    }
                }
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION clear.cookies done`, true);
                setProxyStatusOverlay(mainPage, 'proxy: cookies cleared', 'warn');
            }
            catch (err) {
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION clear.cookies error ${String(err)}`, true);
                setProxyStatusOverlay(mainPage, 'proxy: clear failed', 'error');
            }
        });
        await context.exposeBinding('playwrightProxyToggle', async (_source, enabled) => {
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION proxy.toggle requested=${enabled} (effet au prochain run)`, true);
            setProxyStatusOverlay(mainPage, enabled ? 'proxy ON (appliqué au prochain run)' : 'proxy OFF (appliqué au prochain run)', enabled ? 'warn' : 'warn');
        });
        const page = await context.newPage();
        mainPage = page;
        overlayPage = page;
        await page.addInitScript(() => {
            const throttle = (fn, wait) => {
                let last = 0;
                return (...args) => {
                    const now = Date.now();
                    if (now - last > wait) {
                        last = now;
                        return fn(...args);
                    }
                };
            };
            const forwardEvent = (type, ev) => {
                const path = (ev.composedPath && ev.composedPath()) || [];
                const target = path[0];
                const selector = target?.id
                    ? `#${target.id}`
                    : target?.className
                        ? `${target.tagName.toLowerCase()}.${String(target.className).replace(/\s+/g, '.')}`
                        : target?.tagName?.toLowerCase() || 'unknown';
                const value = target?.value ||
                    target?.value ||
                    target?.value ||
                    '';
                const coords = typeof ev.clientX === 'number' && typeof ev.clientY === 'number'
                    ? `x=${ev.clientX} y=${ev.clientY}`
                    : '';
                // @ts-ignore
                window.logUserEvent?.({ type, target: selector, value: value ? `${value} ${coords}` : coords });
            };
            ['click', 'mousedown', 'input', 'change', 'keydown'].forEach((eventName) => {
                window.addEventListener(eventName, (ev) => {
                    forwardEvent(eventName, ev);
                }, { capture: true });
            });
            // Souris (throttle pour limiter le bruit)
            const mouseMoveHandler = throttle((ev) => {
                // @ts-ignore
                window.logUserEvent?.({
                    type: 'mousemove',
                    target: ev.target?.tagName?.toLowerCase() || 'unknown',
                    value: `x=${ev.clientX} y=${ev.clientY}`
                });
            }, 250);
            window.addEventListener('mousemove', mouseMoveHandler, { capture: true });
        });
        await injectRecordingUi(page);
        await page.exposeBinding('playwrightCaptureShot', async () => {
            try {
                screenshotCounter += 1;
                const shotPath = path.join(RUN_DIR, `manual-shot-${screenshotCounter}.png`);
                await page.screenshot({ path: shotPath, fullPage: true });
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION screenshot.captured path=${shotPath}`, true);
            }
            catch (err) {
                appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION screenshot.error ${String(err)}`, true);
            }
        });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: RUN_ID });
        page.on('console', (msg) => {
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] Console ${msg.type()}: ${msg.text()}`);
        });
        page.on('pageerror', (err) => {
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] PageError: ${err.message}`);
        });
        page.on('framenavigated', (frame) => {
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] Frame navigated: ${frame.url()}`);
        });
        page.on('load', () => appendLine(ACTION_LOG, `[${new Date().toISOString()}] Event: load`));
        page.on('domcontentloaded', () => appendLine(ACTION_LOG, `[${new Date().toISOString()}] Event: domcontentloaded`));
        page.on('request', (req) => void handleRequestLogging(req));
        page.on('requestfinished', (req) => appendLine(NETWORK_LOG, `[${new Date().toISOString()}] Request finished ${req.method()} ${req.url()}`, false));
        page.on('response', (res) => void handleResponseLogging(res, suspected));
        page.on('requestfailed', (req) => void handleRequestFailedLogging(req, suspected));
        if (proxy) {
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] Proxy actif: ${proxy.server} | user: ${proxy.username} | source: ${config.proxySource || 'config'} | headless: ${config.headless ?? false}`);
            setProxyStatusOverlay(overlayPage, `proxy: ${proxy.server} (${proxy.username})`, 'warn');
            await page.evaluate((enabled) => {
                // @ts-ignore
                window.__setProxyToggleState?.(enabled);
            }, true);
            const ipOk = await logPublicIp(context);
            if (!ipOk)
                proxyFailed = true;
        }
        else {
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] Proxy désactivé (mode direct) | headless: ${config.headless ?? false}`);
            setProxyStatusOverlay(overlayPage, 'proxy OFF (direct)', 'error');
            await page.evaluate((enabled) => {
                // @ts-ignore
                window.__setProxyToggleState?.(enabled);
            }, false);
        }
        const startUrl = config.startUrl || 'https://www.seloger.com/?tab=buy';
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION open.startUrl url=${startUrl}`);
        try {
            await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        }
        catch (err) {
            appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION open.error ${String(err)}`);
            proxyFailed = true;
        }
        const recorded = new Promise((resolve) => {
            recordFinished = resolve;
        });
        appendLine(ACTION_LOG, `[${new Date().toISOString()}] ACTION ready. Click Start rec to begin, Stop rec to finish.`);
        await recorded;
        await context.storageState({ path: SESSION_FILE });
        await context.tracing.stop({ path: path.join(RUN_DIR, 'trace-record.zip') });
    }
    finally {
        await context?.close().catch(() => { });
        await browser?.close().catch(() => { });
    }
    return { proxyFailed };
}
async function main() {
    const configPath = process.argv[2] || path.join(__dirname, 'config.json');
    const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const cfg = {
        proxyEnabled: rawConfig.proxyEnabled ?? true,
        proxy: rawConfig.proxy,
        proxyListPath: rawConfig.proxyListPath || path.join(__dirname, 'iproyal-proxies.txt'),
        useProxyPool: rawConfig.useProxyPool ?? true,
        zoneCode: process.argv[3] || rawConfig.zoneCode || '75015',
        pageNumber: parseInt(process.argv[4] || `${rawConfig.pageNumber || 1}`, 10),
        headless: rawConfig.headless ?? false,
        startUrl: process.argv[5] || rawConfig.startUrl
    };
    const maxRetries = cfg.maxProxyRetries ?? 3;
    const autoRetry = cfg.autoRetryProxy ?? true;
    const attempted = new Set();
    let attempt = 0;
    let lastError = null;
    while (attempt <= maxRetries) {
        let proxy;
        let source = 'disabled';
        if (cfg.proxyEnabled !== false) {
            const picked = pickProxy(cfg);
            proxy = picked.proxy;
            source = picked.source;
            const key = `${proxy.server}|${proxy.username}|${proxy.password}`;
            if (attempted.has(key) && attempt < maxRetries) {
                attempt += 1;
                continue;
            }
            attempted.add(key);
        }
        cfg.proxy = proxy;
        cfg.proxySource = source;
        console.log('Demarrage mode recorder');
        console.log(`Start URL: ${cfg.startUrl || 'https://www.seloger.com/?tab=buy'}`);
        console.log(proxy
            ? `Proxy source: ${source} -> ${proxy.server} (${proxy.username})`
            : 'Proxy désactivé (direct)');
        console.log(`Run dir: ${RUN_DIR}`);
        const { proxyFailed } = await runRecorder(cfg);
        if (!proxyFailed || !autoRetry || cfg.proxyEnabled === false) {
            break;
        }
        lastError = 'proxy failed';
        attempt += 1;
        console.log(`Proxy KO, nouvelle tentative (${attempt}/${maxRetries})...`);
    }
    if (lastError) {
        console.log(`Terminé avec erreur proxy: ${lastError}`);
    }
    else {
        console.log(`\nRecorder terminé. Artefacts dans: ${RUN_DIR}`);
    }
}
main().catch((err) => {
    console.error('Erreur non geree:', err);
    process.exit(1);
});
