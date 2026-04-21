import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Tutorial Sync Logic
 * 
 * Flow:
 * 1. Backup local data & DB
 * 2. Copy external favorites.json
 * 3. Run normalization script
 * 4. Run import script
 */

const PROJECT_ROOT = path.join(__dirname, '../..');
const EXTERNAL_SOURCE = '/Users/yingdongma/Documents/Dev/codex/output/pingpong-merged/favorites.json';
const LOCAL_RAW = path.join(PROJECT_ROOT, 'resources/tutorials/raw/favorites.json');
const LOCAL_DB = path.join(__dirname, '../topstar.db');
const NORMALIZED_DATA = path.join(__dirname, '../data/tutorials.pingpong-merged.normalized.json');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups/tutorials');

const NORMALIZE_SCRIPT = path.join(__dirname, 'normalize_pingpong_merged_tutorials.js');
const IMPORT_SCRIPT = path.join(__dirname, 'importTutorials.ts');

function getTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function backup() {
    const ts = getTimestamp();
    const backupFolder = path.join(BACKUP_DIR, ts);
    fs.mkdirSync(backupFolder, { recursive: true });

    if (fs.existsSync(LOCAL_RAW)) {
        fs.copyFileSync(LOCAL_RAW, path.join(backupFolder, 'favorites.json.bak'));
    }
    if (fs.existsSync(LOCAL_DB)) {
        fs.copyFileSync(LOCAL_DB, path.join(backupFolder, 'topstar.db.bak'));
    }
    if (fs.existsSync(NORMALIZED_DATA)) {
        fs.copyFileSync(NORMALIZED_DATA, path.join(backupFolder, 'normalized.json.bak'));
    }
    return backupFolder;
}

/**
 * Main execution function for synchronization.
 * Can be called from CLI or Cron Job.
 */
export async function runSyncTutorials() {
    let backupPath = '';
    console.log('[Sync] Starting tutorial synchronization process...');
    
    try {
        backupPath = backup();
        console.log(`[Sync] Backups created in ${backupPath}`);

        console.log('[Sync] Copying from external source...');
        if (!fs.existsSync(EXTERNAL_SOURCE)) {
            throw new Error(`Source file not found at ${EXTERNAL_SOURCE}`);
        }
        fs.mkdirSync(path.dirname(LOCAL_RAW), { recursive: true });
        fs.copyFileSync(EXTERNAL_SOURCE, LOCAL_RAW);
        console.log('[Sync] Successfully copied favorites.json');

        console.log('[Sync] Running normalization...');
        const normalizeCmd = `node "${NORMALIZE_SCRIPT}" --input "${LOCAL_RAW}" --output "${NORMALIZED_DATA}"`;
        execSync(normalizeCmd, { stdio: 'inherit' });

        console.log('[Sync] Importing to database...');
        // We use npx tsx so it works regardless of how the parent process is running
        const importCmd = `npx tsx "${IMPORT_SCRIPT}"`;
        execSync(importCmd, { stdio: 'inherit', cwd: path.join(__dirname, '..') });

        console.log('[Sync] ✅ Tutorial synchronization successful!');
        return { success: true, backupPath };
    } catch (error: any) {
        console.error('[Sync] ❌ Error during synchronization:', error.message);
        return { success: false, error: error.message, backupPath };
    }
}

// Allow CLI execution
if (require.main === module) {
    runSyncTutorials().then(result => {
        if (!result.success) process.exit(1);
    });
}
