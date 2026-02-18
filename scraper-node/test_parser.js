const { scrapeTopFree, checkRuStore, closeBrowser } = require('./src/parser');

async function test() {
    try {
        console.log('=== Testing AppBrain scraping ===');
        const apps = await scrapeTopFree();
        console.log(`Found ${apps.length} apps`);
        console.log('First 5:', apps.slice(0, 5));

        if (apps.length > 0) {
            const app = apps[0];
            console.log(`\n=== Testing RuStore check for: ${app.title} ===`);
            const report = await checkRuStore(app.title, app.category, app.gp_rating);
            console.log('Report:', JSON.stringify(report, null, 2));
        }
    } catch (err) {
        console.error('Test failed:', err);
    } finally {
        await closeBrowser();
        process.exit(0);
    }
}

test();
