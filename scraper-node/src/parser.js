const { chromium } = require('playwright');

const APP_BRAIN_TOP_FREE_URL = 'https://www.appbrain.com/stats/google-play-rankings';
const APP_BRAIN_TOP_NEW_FREE_URL = 'https://www.appbrain.com/stats/google-play-rankings/top_new_free/all/us';
const RUSTORE_SEARCH_URL = 'https://www.rustore.ru/catalog/search?query=';

// ═════════════════════════════════════════════════════════════════════
// 2.5 — Retry с exponential backoff
// ═════════════════════════════════════════════════════════════════════

async function withRetry(fn, { maxRetries = 3, baseDelay = 1000, name = 'operation' } = {}) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === maxRetries) throw err;
            const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
            console.warn(`[retry] ${name} attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${Math.round(delay)}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ═════════════════════════════════════════════════════════════════════
// Browser management (без изменений, singleton)
// ═════════════════════════════════════════════════════════════════════

let browser = null;
let rusContext = null;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        console.log('Launching Chromium browser...');
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        console.log('Browser launched successfully');
    }
    return browser;
}

async function getRuStoreContext() {
    if (rusContext) return rusContext;

    const b = await getBrowser();
    rusContext = await b.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 }
    });

    await rusContext.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
            return route.abort();
        }
        return route.continue();
    });

    return rusContext;
}

async function closeBrowser() {
    if (rusContext) {
        await rusContext.close().catch(() => {});
        rusContext = null;
    }
    if (browser) {
        await browser.close();
        browser = null;
        console.log('Browser closed');
    }
}

// ═════════════════════════════════════════════════════════════════════
// AppBrain scraping (+ retry)
// ═════════════════════════════════════════════════════════════════════

async function scrapeAppBrain(url) {
    console.log(`Scraping AppBrain: ${url}`);
    const b = await getBrowser();
    const context = await b.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
    });
    const page = await context.newPage();

    try {
        // 2.5 — retry навигации
        await withRetry(
            () => page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }),
            { name: 'AppBrain goto', maxRetries: 3, baseDelay: 2000 }
        );
        await page.waitForSelector('tr td', { timeout: 30000 });

        const apps = await page.evaluate(() => {
            const rows = document.querySelectorAll('tr');
            const results = [];

            rows.forEach((row, i) => {
                if (i === 0) return;
                const cells = row.querySelectorAll('td');

                if (cells.length >= 7) {
                    const rank = parseInt(cells[0].textContent.trim()) || 0;
                    const titleLink = cells[3] ? cells[3].querySelector('a') : null;
                    if (!titleLink) return;

                    const title = titleLink.textContent.trim();
                    const href = titleLink.getAttribute('href') || '';
                    const gp_url = href.startsWith('http') ? href : 'https://www.appbrain.com' + href;

                    const category = cells[4] ? cells[4].textContent.trim() : '';
                    const gp_rating = parseFloat(cells[5] ? cells[5].textContent.trim() : '0') || 0;
                    const installs = cells[6] ? cells[6].textContent.trim() : 'N/A';
                    const recent = cells[7] ? cells[7].textContent.trim() : 'N/A';

                    if (title && title !== 'N/A' && rank > 0) {
                        results.push({
                            rank,
                            title,
                            category: category || 'General',
                            gp_rating,
                            installs: installs || 'N/A',
                            recent: recent || 'N/A',
                            gp_url
                        });
                    }
                }
            });

            return results;
        });

        console.log(`Found ${apps.length} apps on AppBrain`);
        return apps.slice(0, 100);
    } catch (error) {
        console.error('Failed to scrape AppBrain:', error.message);
        return [];
    } finally {
        await context.close();
    }
}

async function scrapeTopFree() {
    return scrapeAppBrain(APP_BRAIN_TOP_FREE_URL);
}

async function scrapeTopNewFree() {
    return scrapeAppBrain(APP_BRAIN_TOP_NEW_FREE_URL);
}

// ═════════════════════════════════════════════════════════════════════
// 2.6 — Контекстная очистка поискового запроса
// ═════════════════════════════════════════════════════════════════════

// Общие стоп-слова, безопасные для удаления из любого контекста
const UNIVERSAL_FILLER = new Set([
    'for android', 'for phone', 'for mobile', 'pro', 'free', 'app',
    'lite', 'plus', 'premium', 'mod', 'the', 'a', 'an',
    'new', 'best', 'top', 'ultimate', 'official'
]);

// Категорийные стоп-слова — удаляем только если приложение в этой категории
const CATEGORY_FILLER = {
    'Tools':              new Set(['tool', 'tools', 'utility', 'utilities', 'helper']),
    'Communication':      new Set(['messenger', 'messaging', 'chat', 'call', 'calling']),
    'Photography':        new Set(['photo', 'camera', 'picture', 'pic', 'image']),
    'Music & Audio':      new Set(['music', 'player', 'audio', 'sound', 'mp3']),
    'Entertainment':      new Set(['entertainment', 'fun', 'funny']),
    'Education':          new Set(['learn', 'learning', 'education', 'study', 'school']),
    'Health & Fitness':   new Set(['health', 'fitness', 'workout', 'exercise']),
    'Finance':            new Set(['finance', 'money', 'bank', 'banking', 'pay', 'payment']),
    'Productivity':       new Set(['productivity', 'organizer', 'planner']),
    'Shopping':           new Set(['shopping', 'shop', 'store', 'deals', 'coupons', 'sale']),
    'Social':             new Set(['social', 'network', 'friends', 'community']),
    'Travel & Local':     new Set(['travel', 'hotel', 'flights', 'booking', 'trip', 'guide']),
    'Weather':            new Set(['weather', 'forecast', 'radar', 'climate']),
    'Lifestyle':          new Set(['lifestyle', 'fashion', 'style', 'beauty']),
    'Video Players & Editors': new Set(['video', 'player', 'editor', 'movie', 'clip']),
    'Maps & Navigation':  new Set(['maps', 'map', 'navigation', 'gps', 'directions']),
    'News & Magazines':   new Set(['news', 'magazine', 'headlines', 'daily']),
    'Food & Drink':       new Set(['food', 'recipe', 'restaurant', 'cooking', 'delivery']),
    'Business':           new Set(['business', 'office', 'corporate', 'enterprise']),
};

/**
 * Определяет, является ли токен брендовым/собственным именем.
 * Такие токены защищены от удаления стоп-словами.
 *
 * Паттерны:
 * - CamelCase: WhatsApp, TikTok, YouTube, DoorDash
 * - ALL_CAPS (≥2 букв): VPN, GPS, PDF, AI, QR
 * - Буквы + цифры: MP3, 4K, 360cam, S21
 * - Содержит ™ или ®
 */
function isBrandToken(originalWord) {
    // CamelCase — маленькая буква перед большой
    if (/[a-z][A-Z]/.test(originalWord)) return true;
    // ALL_CAPS (минимум 2 буквы)
    if (/^[A-Z]{2,}$/.test(originalWord)) return true;
    // Смешанные буквы и цифры: MP3, 4K, H2O, S21
    if (/[a-zA-Z]/.test(originalWord) && /\d/.test(originalWord)) return true;
    // Торговые знаки
    if (/[™®©]/.test(originalWord)) return true;
    return false;
}

function cleanSearchQuery(title, category = '') {
    // Защита коротких названий — если 1-2 слова, не трогаем
    const words = title.trim().split(/\s+/);
    if (words.length <= 2) {
        // Только убираем пунктуацию
        let cleaned = title.replace(/[,()[\]:;!?'"™®©]/g, ' ').replace(/\s+/g, ' ').trim();
        return cleaned.length >= 2 ? cleaned : title;
    }

    // Определяем защищённые токены ДО lowercasing
    // 1) Брендовые паттерны (CamelCase, ALL_CAPS, цифры)
    // 2) Первое слово названия (обычно бренд: "Spotify Music", "Zoom Meetings")
    const protectedWords = new Set();
    words.forEach((w, i) => {
        const clean = w.replace(/[,()[\]:;!?'"&\-–—™®©]/g, '');
        if (!clean) return;
        if (isBrandToken(clean) || i === 0) {
            protectedWords.add(clean.toLowerCase());
        }
    });

    let cleaned = title.toLowerCase();

    // Убираем универсальные стоп-слова (но не защищённые)
    for (const phrase of UNIVERSAL_FILLER) {
        // Пропускаем если фраза — одно слово и оно защищено
        const phraseWords = phrase.split(/\s+/);
        if (phraseWords.length === 1 && protectedWords.has(phraseWords[0])) continue;
        cleaned = cleaned.replace(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
    }

    // Убираем категорийные стоп-слова (только если не защищены)
    const catFillers = CATEGORY_FILLER[category];
    if (catFillers) {
        for (const word of catFillers) {
            if (protectedWords.has(word)) continue;
            cleaned = cleaned.replace(new RegExp(`\\b${word}\\b`, 'gi'), ' ');
        }
    }

    // Убираем пунктуацию и мусорные символы
    cleaned = cleaned.replace(/[,()[\]:;!?'"&\-–—™®©]/g, ' ');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Защита минимальной длины — если после очистки осталось <2 значащих слов,
    // откатываемся на мягкую очистку (только пунктуация)
    const remainingWords = cleaned.split(/\s+/).filter(w => w.length >= 2);
    if (remainingWords.length < 2 || cleaned.length < 3) {
        cleaned = title.replace(/[,()[\]:;!?'"&\-–—™®©]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    return cleaned.length >= 2 ? cleaned : title;
}

// ═════════════════════════════════════════════════════════════════════
// 2.1 — Классификация названия: бренд / описательное / смешанное
// ═════════════════════════════════════════════════════════════════════

/**
 * Определяет тип названия приложения.
 *
 * - 'brand'       — всё название = бренд (WhatsApp, TikTok, YouTube Shorts)
 *                   → НЕ переводим, ищем оригинал
 * - 'descriptive' — все слова описательные (Photo Editor, Music Player)
 *                   → переводим на русский
 * - 'mixed'       — бренд + описание (Spotify Music, Google Maps)
 *                   → НЕ переводим (RuStore нормально ищет латиницу)
 *
 * @returns {{ type: 'brand'|'descriptive'|'mixed', brandWords: string[], otherWords: string[] }}
 */
function classifyTitle(title) {
    const words = title.trim().split(/\s+/);
    const brandWords = [];
    const otherWords = [];

    for (const w of words) {
        const clean = w.replace(/[,()[\]:;!?'"&\-–—™®©]/g, '');
        if (!clean) continue;

        if (isBrandToken(clean)) {
            brandWords.push(clean);
        } else {
            otherWords.push(clean);
        }
    }

    // Убираем универсальные филлеры из otherWords — они не делают название описательным
    const meaningfulOther = otherWords.filter(w => {
        const lower = w.toLowerCase();
        return !UNIVERSAL_FILLER.has(lower) && lower.length >= 2;
    });

    if (brandWords.length > 0 && meaningfulOther.length === 0) {
        return { type: 'brand', brandWords, otherWords: meaningfulOther };
    }
    if (brandWords.length > 0 && meaningfulOther.length > 0) {
        return { type: 'mixed', brandWords, otherWords: meaningfulOther };
    }
    return { type: 'descriptive', brandWords, otherWords: meaningfulOther };
}

// Кэш переводов — не переводим одно и то же дважды
const translationCache = new Map();

// Переводим очищенное название на русский через MyMemory API
async function translateToRussian(text) {
    // Если текст уже кириллический — не переводим
    if (/[а-яё]/i.test(text)) return text;

    if (translationCache.has(text)) {
        console.log(`Translation cache hit: "${text}" → "${translationCache.get(text)}"`);
        return translationCache.get(text);
    }

    try {
        // 2.5 — retry запроса к MyMemory Translation API
        const translated = await withRetry(async () => {
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ru`;
            const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error(`MyMemory HTTP ${response.status}`);
            const data = await response.json();
            return data.responseData.translatedText;
        }, { name: 'MyMemory translate', maxRetries: 3, baseDelay: 1000 });

        if (translated && translated.toLowerCase() !== text.toLowerCase()) {
            console.log(`Translated: "${text}" → "${translated}"`);
            translationCache.set(text, translated);
            return translated;
        }
    } catch (error) {
        console.error(`Translation failed for "${text}" after retries:`, error.message);
    }
    // Fallback — возвращаем оригинал
    return text;
}

// ═════════════════════════════════════════════════════════════════════
// 2.2 — Проверка релевантности результатов
// ═════════════════════════════════════════════════════════════════════

const RELEVANCE_THRESHOLD = 0.15;

/**
 * Jaccard similarity на уровне слов.
 * Возвращает 0–1 (1 = идентичные наборы слов).
 */
function wordJaccard(a, b) {
    const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length >= 2));
    const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length >= 2));

    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const w of setA) {
        if (setB.has(w)) intersection++;
    }

    return intersection / new Set([...setA, ...setB]).size;
}

/**
 * Проверка вхождения подстроки (нормализованная).
 * "calculator" ⊂ "calculator pro" → true
 */
function substringMatch(a, b) {
    const al = a.toLowerCase().trim();
    const bl = b.toLowerCase().trim();
    if (al.length < 2 || bl.length < 2) return false;
    return al.includes(bl) || bl.includes(al);
}

/**
 * Рассчитывает релевантность найденного конкурента.
 *
 * Сравниваем название конкурента с:
 *  - searchQuery (может быть переведён на русский)
 *  - cleanedTitle (оригинальное очищенное, на случай если конкурент на латинице)
 *
 * @returns {number} 0–1, где ≥ RELEVANCE_THRESHOLD = релевантный
 */
function calculateRelevance(competitor, searchQuery, cleanedTitle) {
    // Jaccard по searchQuery (русский или оригинал)
    const jaccardQuery = wordJaccard(competitor.name, searchQuery);
    // Jaccard по очищенному оригинальному названию (латиница)
    const jaccardOriginal = wordJaccard(competitor.name, cleanedTitle);
    // Берём лучший из двух
    const bestJaccard = Math.max(jaccardQuery, jaccardOriginal);

    let score = bestJaccard * 0.6;

    // Бонус за подстроку
    if (substringMatch(competitor.name, searchQuery) || substringMatch(competitor.name, cleanedTitle)) {
        score += 0.3;
    }

    // Небольшой бонус за наличие рейтинга (состоявшееся приложение)
    if (competitor.rating !== null) {
        score += 0.1;
    }

    return Math.min(1, score);
}

async function checkRuStore(title, category, gpRating, installs) {
    const startTime = Date.now();
    console.log(`\n=== checkRuStore: "${title}" (installs: ${installs || 'N/A'}) ===`);

    // 1. Классифицируем название (бренд / описательное / смешанное)
    const classification = classifyTitle(title);
    console.log(`Title type: ${classification.type} (brand words: [${classification.brandWords.join(', ')}])`);

    // 2. Очищаем название от мусорных слов
    const cleaned = cleanSearchQuery(title, category);
    console.log(`Cleaned query: "${cleaned}"`);

    // 3. Переводим ТОЛЬКО описательные названия
    //    Бренды и смешанные — ищем оригинал (RuStore нормально ищет латиницу)
    let searchQuery;
    if (classification.type === 'descriptive') {
        searchQuery = await translateToRussian(cleaned);
        console.log(`Descriptive → translated to: "${searchQuery}"`);
    } else {
        searchQuery = cleaned;
        console.log(`${classification.type} → keeping original: "${searchQuery}"`);
    }

    const searchUrl = RUSTORE_SEARCH_URL + encodeURIComponent(searchQuery);
    console.log(`Search URL: ${searchUrl}`);

    // 3. Парсим результаты поиска RuStore через Playwright
    const context = await getRuStoreContext();
    const page = await context.newPage();

    let competitors = [];

    try {
        // 2.5 — retry навигации на RuStore
        await withRetry(
            () => page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }),
            { name: 'RuStore goto', maxRetries: 3, baseDelay: 2000 }
        );

        // Ждём появления карточек или сообщения "ничего не найдено"
        try {
            await page.waitForSelector('[data-testid="app-card"]', { timeout: 5000 });
        } catch {
            console.log('No app cards found on RuStore for this query');
            const score = calculateOpportunityScore({
                competitorsCount: 0,
                avgRating: null,
                maxRating: null,
                gpRating: gpRating || 0,
                installs: installs || 'N/A'
            });
            console.log(`Done in ${Date.now() - startTime}ms`);
            return {
                searchQuery,
                searchUrl,
                competitorsCount: 0,
                topCompetitors: [],
                avgRating: null,
                maxRating: null,
                opportunityScore: score
            };
        }

        // 4. Извлекаем данные из карточек приложений
        competitors = await page.evaluate(() => {
            const cards = document.querySelectorAll('[data-testid="app-card"]');
            const results = [];

            cards.forEach(card => {
                const href = card.getAttribute('href') || '';
                const url = href.startsWith('http') ? href : 'https://www.rustore.ru' + href;

                // Название — первый <p> внутри карточки
                const paragraphs = card.querySelectorAll('p');
                const name = paragraphs[0] ? paragraphs[0].textContent.trim() : '';
                const cat = paragraphs[1] ? paragraphs[1].textContent.trim() : '';

                // Рейтинг — span[data-testid="rating"]
                const ratingEl = card.querySelector('[data-testid="rating"]');
                let rating = null;
                if (ratingEl) {
                    const ratingText = ratingEl.textContent.trim().replace(',', '.');
                    rating = parseFloat(ratingText) || null;
                }

                if (name) {
                    results.push({ name, category: cat, rating, url });
                }
            });

            return results;
        });

        console.log(`Found ${competitors.length} raw results on RuStore`);

    } catch (error) {
        console.error('Failed to scrape RuStore:', error.message);
    } finally {
        await page.close();
    }

    // 5. Фильтрация по релевантности (2.2)
    //    Сравниваем каждого конкурента с searchQuery и cleaned-названием
    for (const c of competitors) {
        c.relevance = calculateRelevance(c, searchQuery, cleaned);
        c.relevant = c.relevance >= RELEVANCE_THRESHOLD;
    }

    const relevant = competitors.filter(c => c.relevant);
    const filtered = competitors.length - relevant.length;
    if (filtered > 0) {
        console.log(`Relevance filter: ${relevant.length} relevant, ${filtered} filtered out (threshold ${RELEVANCE_THRESHOLD})`);
    }

    // 6. Статистика только по релевантным конкурентам
    const competitorsCount = relevant.length;
    const ratingsOnly = relevant.filter(c => c.rating !== null).map(c => c.rating);
    const avgRating = ratingsOnly.length > 0
        ? Math.round((ratingsOnly.reduce((a, b) => a + b, 0) / ratingsOnly.length) * 10) / 10
        : null;
    const maxRating = ratingsOnly.length > 0
        ? Math.max(...ratingsOnly)
        : null;

    // 7. Топ-5 релевантных конкурентов по рейтингу
    const topCompetitors = [...relevant]
        .sort((a, b) => (b.rating || 0) - (a.rating || 0))
        .slice(0, 5);

    // 8. Рассчитываем Opportunity Score
    const opportunityScore = calculateOpportunityScore({
        competitorsCount,
        avgRating,
        maxRating,
        gpRating: gpRating || 0,
        installs: installs || 'N/A'
    });

    console.log(`Relevant competitors: ${competitorsCount}, Avg: ${avgRating}, Max: ${maxRating}, Score: ${opportunityScore}`);
    console.log(`Done in ${Date.now() - startTime}ms`);

    return {
        searchQuery,
        searchUrl,
        competitorsCount,
        topCompetitors,
        avgRating,
        maxRating,
        opportunityScore
    };
}

// ═════════════════════════════════════════════════════════════════════
// 2.3 — Улучшенная формула Opportunity Score
// ═════════════════════════════════════════════════════════════════════

/**
 * Парсит строку установок AppBrain ("10M+", "500K+", "1B+") в число.
 */
function parseInstalls(installsStr) {
    if (!installsStr || installsStr === 'N/A') return 0;
    const str = installsStr.replace(/[+,]/g, '').trim().toUpperCase();
    const match = str.match(/^([\d.]+)\s*([KMBT]?)$/);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const suffix = match[2];
    const multipliers = { '': 1, 'K': 1e3, 'M': 1e6, 'B': 1e9, 'T': 1e12 };
    return num * (multipliers[suffix] || 1);
}

/**
 * Рассчитывает Opportunity Score (0–100).
 *
 * Взвешенная сумма 5 нормализованных факторов (каждый 0–1):
 *
 * | Фактор               | Вес  | Логика                                          |
 * |----------------------|------|-------------------------------------------------|
 * | Competition gap      | 0.30 | Меньше конкурентов → выше. Плавная шкала 0–20   |
 * | Quality gap          | 0.25 | Ниже средний рейтинг конкурентов → выше          |
 * | Proven demand        | 0.25 | Больше установок оригинала → больше рынок        |
 * | Validated quality    | 0.10 | Выше GP рейтинг оригинала → проверенная идея     |
 * | Top competitor weak  | 0.10 | Ниже макс. рейтинг конкурента → слабая конкуренция|
 */
function calculateOpportunityScore({ competitorsCount, avgRating, maxRating, gpRating, installs }) {
    // Фактор 1: Competition gap — меньше релевантных конкурентов = лучше
    // 0 → 1.0, 10 → 0.5, 20+ → 0.0
    const f1 = Math.max(0, 1 - competitorsCount / 20);

    // Фактор 2: Quality gap — ниже средний рейтинг конкурентов = больше места
    // null (нет конкурентов) → 0.7, rating 2.0 → 1.0, 3.5 → 0.5, 5.0 → 0.0
    const f2 = avgRating === null ? 0.7 : Math.max(0, 1 - (avgRating - 2) / 3);

    // Фактор 3: Proven demand — установки оригинала (подтверждённый спрос)
    // 0 → 0.0, 10K → 0.44, 1M → 0.67, 100M → 0.89, 1B → 1.0
    const installsNum = typeof installs === 'string' ? parseInstalls(installs) : (installs || 0);
    const f3 = installsNum > 0 ? Math.min(1, Math.log10(installsNum + 1) / 9) : 0;

    // Фактор 4: Validated quality — GP рейтинг оригинала
    // <2.5 → 0.0, 3.5 → 0.5, 4.5+ → 1.0
    const f4 = Math.max(0, Math.min(1, (gpRating - 2.5) / 2));

    // Фактор 5: Top competitor weakness — слабость лучшего конкурента
    // null (нет конкурентов) → 1.0, rating 2.0 → 1.0, 3.5 → 0.5, 5.0 → 0.0
    const f5 = maxRating === null ? 1.0 : Math.max(0, 1 - (maxRating - 2) / 3);

    // Взвешенная сумма
    const raw = 0.30 * f1 + 0.25 * f2 + 0.25 * f3 + 0.10 * f4 + 0.10 * f5;
    const score = Math.round(100 * raw);

    return Math.max(0, Math.min(100, score));
}

module.exports = {
    scrapeTopFree,
    scrapeTopNewFree,
    checkRuStore,
    closeBrowser
};
