const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'shared', 'data.db');

// ─── Singleton connection ───────────────────────────────────────────
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Failed to connect to database:', err.message);
        process.exit(1);
    }
    console.log(`Connected to SQLite: ${dbPath}`);
});

// WAL mode — читатели не блокируют писателей
db.run('PRAGMA journal_mode = WAL');
// Ждём до 5 секунд при блокировке вместо мгновенного SQLITE_BUSY
db.run('PRAGMA busy_timeout = 5000');
// Включаем foreign keys для CASCADE
db.run('PRAGMA foreign_keys = ON');

// ─── Promisified helpers ────────────────────────────────────────────
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// ─── Schema initialization ──────────────────────────────────────────
async function initSchema() {
    await dbRun(`
        CREATE TABLE IF NOT EXISTS apps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rank INTEGER,
            title TEXT NOT NULL,
            category TEXT,
            gp_rating REAL,
            installs TEXT,
            recent TEXT,
            gp_url TEXT,
            rustore_exists INTEGER DEFAULT NULL,
            rustore_rating REAL,
            diff_rating REAL,
            opportunity_score INTEGER DEFAULT NULL,
            source TEXT DEFAULT 'top_free',
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS rustore_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            app_id INTEGER NOT NULL,
            search_query TEXT,
            search_url TEXT,
            competitors_count INTEGER DEFAULT 0,
            avg_rating REAL,
            max_rating REAL,
            opportunity_score INTEGER,
            top_competitors TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
        )
    `);

    // Таблицы для Flow 2 (проверка пользовательских идей)
    await dbRun(`
        CREATE TABLE IF NOT EXISTS idea_checks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            verdict TEXT,
            reasoning TEXT,
            search_query TEXT,
            estimated_category TEXT,
            estimated_gp_rating REAL,
            estimated_installs TEXT,
            opportunity_score INTEGER,
            skipped_rustore INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS idea_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            idea_id INTEGER NOT NULL,
            search_query TEXT,
            search_url TEXT,
            competitors_count INTEGER DEFAULT 0,
            avg_rating REAL,
            max_rating REAL,
            opportunity_score INTEGER,
            top_competitors TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (idea_id) REFERENCES idea_checks(id) ON DELETE CASCADE
        )
    `);

    // Миграции для существующих БД — добавляем колонки если их нет
    const columns = await dbAll("PRAGMA table_info(apps)");
    const columnNames = columns.map(c => c.name);

    if (!columnNames.includes('opportunity_score')) {
        await dbRun('ALTER TABLE apps ADD COLUMN opportunity_score INTEGER DEFAULT NULL');
        console.log('Migrated: added opportunity_score column');
    }
    if (!columnNames.includes('source')) {
        await dbRun("ALTER TABLE apps ADD COLUMN source TEXT DEFAULT 'top_free'");
        console.log('Migrated: added source column');
    }

    console.log('Database schema initialized');
}

// Запускаем инициализацию сразу
const schemaReady = initSchema();

// ─── Data operations ────────────────────────────────────────────────

/**
 * Атомарная замена списка приложений для указанного source.
 * BEGIN → DELETE → batch INSERT → COMMIT
 * При ошибке — ROLLBACK, старые данные остаются на месте.
 */
async function replaceApps(source, apps) {
    await schemaReady;
    await dbRun('BEGIN TRANSACTION');
    try {
        await dbRun('DELETE FROM apps WHERE source = ?', [source]);

        for (const app of apps) {
            await dbRun(
                `INSERT INTO apps (rank, title, category, gp_rating, installs, recent, gp_url, source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [app.rank, app.title, app.category, app.gp_rating, app.installs, app.recent, app.gp_url, source]
            );
        }

        await dbRun('COMMIT');
        console.log(`Replaced ${apps.length} apps for source="${source}"`);
    } catch (err) {
        await dbRun('ROLLBACK');
        console.error('replaceApps failed, rolled back:', err.message);
        throw err;
    }
}

/**
 * Обновляет данные RuStore-проверки для приложения.
 */
async function updateRuStoreData(appId, data) {
    await schemaReady;
    const { rustore_exists, rustore_rating, diff_rating, opportunity_score } = data;
    await dbRun(
        `UPDATE apps SET 
            rustore_exists = ?, 
            rustore_rating = ?, 
            diff_rating = ?,
            opportunity_score = ?,
            last_updated = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [rustore_exists, rustore_rating, diff_rating, opportunity_score, appId]
    );
}

/**
 * Сохраняет полный отчёт проверки RuStore.
 * Удаляет старый отчёт если он существует (один отчёт на приложение).
 * Обёрнуто в транзакцию — DELETE + INSERT атомарны.
 */
async function saveReport(appId, report) {
    await schemaReady;
    await dbRun('BEGIN TRANSACTION');
    try {
        await dbRun('DELETE FROM rustore_reports WHERE app_id = ?', [appId]);

        await dbRun(
            `INSERT INTO rustore_reports (app_id, search_query, search_url, competitors_count, avg_rating, max_rating, opportunity_score, top_competitors)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                appId,
                report.searchQuery,
                report.searchUrl,
                report.competitorsCount,
                report.avgRating,
                report.maxRating,
                report.opportunityScore,
                JSON.stringify(report.topCompetitors || [])
            ]
        );
        await dbRun('COMMIT');
    } catch (err) {
        await dbRun('ROLLBACK');
        console.error('saveReport failed, rolled back:', err.message);
        throw err;
    }
}

/**
 * Получает сохранённый отчёт по appId.
 */
async function getReport(appId) {
    await schemaReady;
    const row = await dbGet('SELECT * FROM rustore_reports WHERE app_id = ?', [appId]);
    if (!row) return null;

    return {
        searchQuery: row.search_query,
        searchUrl: row.search_url,
        competitorsCount: row.competitors_count,
        avgRating: row.avg_rating,
        maxRating: row.max_rating,
        opportunityScore: row.opportunity_score,
        topCompetitors: JSON.parse(row.top_competitors || '[]')
    };
}

/**
 * Получает список приложений с фильтрацией.
 */
async function getApps(source, filter) {
    await schemaReady;
    let query = 'SELECT * FROM apps WHERE source = ?';
    const params = [source];

    if (filter === 'not_checked') {
        query += ' AND rustore_exists IS NULL';
    } else if (filter === 'checked') {
        query += ' AND rustore_exists = 1';
    }

    query += ' ORDER BY rank ASC';
    return dbAll(query, params);
}

/**
 * Сбрасывает все данные RuStore-проверок.
 */
async function resetRuStoreData() {
    await schemaReady;
    await dbRun('BEGIN TRANSACTION');
    try {
        await dbRun('DELETE FROM rustore_reports');
        await dbRun('UPDATE apps SET rustore_exists = NULL, rustore_rating = NULL, diff_rating = NULL, opportunity_score = NULL');
        await dbRun('COMMIT');
    } catch (err) {
        await dbRun('ROLLBACK');
        throw err;
    }
}

/**
 * Закрывает соединение с БД.
 */
function closeDb() {
    return new Promise((resolve) => {
        db.close((err) => {
            if (err) console.error('Error closing database:', err.message);
            else console.log('Database connection closed');
            resolve();
        });
    });
}

// ════════════════════════════════════════════════════════════════════
// Flow 2: Операции с идеями
// ════════════════════════════════════════════════════════════════════

/**
 * Сохраняет проверку идеи (оценка Qwen + результат RuStore).
 * @returns {number} id созданной записи
 */
async function saveIdeaCheck(description, evaluation, ruStoreResult) {
    await schemaReady;
    await dbRun('BEGIN TRANSACTION');
    try {
        const { lastID } = await dbRun(
            `INSERT INTO idea_checks
             (description, verdict, reasoning, search_query, estimated_category, estimated_gp_rating, estimated_installs, opportunity_score, skipped_rustore)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                description,
                evaluation.verdict,
                evaluation.reasoning || '',
                ruStoreResult.searchQuery || evaluation.searchQuery || '',
                evaluation.estimatedCategory || '',
                evaluation.estimatedGpRating || null,
                evaluation.estimatedInstalls || '',
                ruStoreResult.opportunityScore ?? null,
                ruStoreResult.skippedRuStore ? 1 : 0
            ]
        );

        // Сохраняем подробный отчёт если RuStore был опрошен
        if (!ruStoreResult.skippedRuStore && ruStoreResult.searchUrl) {
            await dbRun(
                `INSERT INTO idea_reports
                 (idea_id, search_query, search_url, competitors_count, avg_rating, max_rating, opportunity_score, top_competitors)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    lastID,
                    ruStoreResult.searchQuery,
                    ruStoreResult.searchUrl,
                    ruStoreResult.competitorsCount ?? 0,
                    ruStoreResult.avgRating ?? null,
                    ruStoreResult.maxRating ?? null,
                    ruStoreResult.opportunityScore ?? null,
                    JSON.stringify(ruStoreResult.topCompetitors || [])
                ]
            );
        }

        await dbRun('COMMIT');
        console.log(`Idea check saved: id=${lastID}, verdict=${evaluation.verdict}`);
        return lastID;
    } catch (err) {
        await dbRun('ROLLBACK');
        console.error('saveIdeaCheck failed, rolled back:', err.message);
        throw err;
    }
}

/**
 * Возвращает список проверок идей (History), от новых к старым.
 */
async function getIdeaChecks(limit = 50) {
    await schemaReady;
    return dbAll(
        'SELECT * FROM idea_checks ORDER BY created_at DESC LIMIT ?',
        [limit]
    );
}

/**
 * Возвращает полный отчёт по идее (idea_checks + idea_reports).
 */
async function getIdeaReport(ideaId) {
    await schemaReady;
    const check = await dbGet('SELECT * FROM idea_checks WHERE id = ?', [ideaId]);
    if (!check) return null;

    const report = await dbGet('SELECT * FROM idea_reports WHERE idea_id = ?', [ideaId]);

    return {
        id: check.id,
        description: check.description,
        verdict: check.verdict,
        reasoning: check.reasoning,
        searchQuery: check.search_query,
        estimatedCategory: check.estimated_category,
        estimatedGpRating: check.estimated_gp_rating,
        estimatedInstalls: check.estimated_installs,
        opportunityScore: check.opportunity_score,
        skippedRuStore: !!check.skipped_rustore,
        createdAt: check.created_at,
        ruStoreReport: report ? {
            searchQuery: report.search_query,
            searchUrl: report.search_url,
            competitorsCount: report.competitors_count,
            avgRating: report.avg_rating,
            maxRating: report.max_rating,
            opportunityScore: report.opportunity_score,
            topCompetitors: JSON.parse(report.top_competitors || '[]')
        } : null
    };
}

module.exports = {
    replaceApps,
    updateRuStoreData,
    saveReport,
    getReport,
    getApps,
    resetRuStoreData,
    saveIdeaCheck,
    getIdeaChecks,
    getIdeaReport,
    closeDb
};
