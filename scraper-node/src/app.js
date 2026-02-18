const express = require('express');
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');
const { scrapeTopFree, scrapeTopNewFree, checkRuStore, closeBrowser } = require('./parser');

const BUILD_ID = '20260218-webhook-test';
const { replaceApps, updateRuStoreData, saveReport, getReport, getApps, resetRuStoreData, closeDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// ─── Статика: UI из public/ ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── API: Получить список приложений ─────────────────────────────────
app.get('/api/apps', async (req, res) => {
    const tab = req.query.tab || 'top_free';
    const filter = req.query.filter || 'all';
    try {
        const apps = await getApps(tab, filter);
        res.json({ apps });
    } catch (error) {
        console.error('getApps failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ─── API: Единый эндпоинт обновления списка ─────────────────────────
app.post('/api/update-list', async (req, res) => {
    const tab = req.query.tab || 'top_free';
    try {
        let topApps;
        if (tab === 'top_new_free') {
            topApps = await scrapeTopNewFree();
        } else {
            topApps = await scrapeTopFree();
        }
        topApps = topApps.slice(0, 100);

        if (topApps.length === 0) {
            return res.status(404).json({ error: 'No apps found on AppBrain' });
        }

        await replaceApps(tab, topApps);

        console.log(`AppBrain ${tab} list updated successfully`);
        res.json({ message: 'Scraping completed', count: topApps.length });
    } catch (error) {
        console.error(`Scraping (${tab}) failed:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ─── API: Скрейпинг AppBrain ────────────────────────────────────────
app.post('/api/scrape', async (req, res) => {
    try {
        let topApps = await scrapeTopFree();
        topApps = topApps.slice(0, 100);

        if (topApps.length === 0) {
            return res.status(404).json({ error: 'No apps found on AppBrain' });
        }

        await replaceApps('top_free', topApps);

        console.log('AppBrain Top Free list updated successfully');
        res.json({ message: 'Scraping completed', count: topApps.length });
    } catch (error) {
        console.error('Scraping failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/scrape-new-free', async (req, res) => {
    try {
        let topApps = await scrapeTopNewFree();
        topApps = topApps.slice(0, 100);

        if (topApps.length === 0) {
            return res.status(404).json({ error: 'No apps found on AppBrain (Top New Free)' });
        }

        await replaceApps('top_new_free', topApps);

        console.log('AppBrain Top New Free list updated successfully');
        res.json({ message: 'Scraping completed (Top New Free)', count: topApps.length });
    } catch (error) {
        console.error('Scraping (Top New Free) failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ─── API: Проверка приложения в RuStore ─────────────────────────────
app.post('/api/check/:id', async (req, res) => {
    const appId = req.params.id;
    const { title, gp_rating, category, installs } = req.body;

    if (!title) {
        return res.status(400).json({ error: 'Title is required' });
    }

    try {
        console.log(`Check requested for ID ${appId}: ${title} (category: ${category})`);
        const report = await checkRuStore(title, category, gp_rating, installs);

        // Обновляем данные проверки в таблице apps
        await updateRuStoreData(appId, {
            rustore_exists: 1,
            rustore_rating: null,
            diff_rating: null,
            opportunity_score: report.opportunityScore
        });

        // Сохраняем полный отчёт в отдельную таблицу
        await saveReport(appId, report);

        res.json({
            success: true,
            report: {
                searchQuery: report.searchQuery,
                searchUrl: report.searchUrl,
                competitorsCount: report.competitorsCount,
                avgRating: report.avgRating,
                maxRating: report.maxRating,
                opportunityScore: report.opportunityScore,
                topCompetitors: report.topCompetitors
            }
        });
    } catch (error) {
        console.error(`Check failed for app ${appId}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ─── API: Получить сохранённый отчёт ────────────────────────────────
app.get('/api/report/:id', async (req, res) => {
    try {
        const report = await getReport(req.params.id);
        if (!report) {
            return res.status(404).json({ error: 'Report not found' });
        }
        res.json({ success: true, report });
    } catch (error) {
        console.error('Get report error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ─── API: Сброс всех проверок RuStore ───────────────────────────────
app.post('/api/reset-rustore', async (req, res) => {
    try {
        await resetRuStoreData();
        res.json({ message: 'RuStore data reset successfully' });
    } catch (error) {
        console.error('Reset error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ─── SPA Fallback: все неизвестные GET → index.html ─────────────────
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Запуск ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`RuStore Parser running on http://localhost:${PORT}`);
});

// Graceful shutdown — закрываем браузер и БД при остановке
async function shutdown() {
    console.log('Shutting down...');
    await closeBrowser();
    await closeDb();
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
