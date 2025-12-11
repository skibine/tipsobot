-- Migration script: Migrate from global stats to per-town stats
-- This script preserves all existing data by assigning it to a default space_id
-- Run this BEFORE updating the schema

-- Step 1: Backup existing tables (optional but recommended)
CREATE TABLE IF NOT EXISTS global_stats_backup AS SELECT * FROM global_stats WHERE 1=0;
CREATE TABLE IF NOT EXISTS user_stats_backup AS SELECT * FROM user_stats WHERE 1=0;
CREATE TABLE IF NOT EXISTS user_cooldowns_backup AS SELECT * FROM user_cooldowns WHERE 1=0;
CREATE TABLE IF NOT EXISTS pending_transactions_backup AS SELECT * FROM pending_transactions WHERE 1=0;

-- Step 2: Backup current data
INSERT INTO global_stats_backup SELECT * FROM global_stats;
INSERT INTO user_stats_backup SELECT * FROM user_stats;
INSERT INTO user_cooldowns_backup SELECT * FROM user_cooldowns;
INSERT INTO pending_transactions_backup SELECT * FROM pending_transactions;

-- Step 3: Create new tables with space_id
-- Run the updated schema.sql here, or manually create tables:

CREATE TABLE IF NOT EXISTS global_stats_new (
    space_id VARCHAR(100) NOT NULL,
    total_tips_volume DECIMAL(20, 2) DEFAULT 0,
    total_tips_count INTEGER DEFAULT 0,
    total_donations_volume DECIMAL(20, 2) DEFAULT 0,
    total_donations_count INTEGER DEFAULT 0,
    total_crowdfunding_volume DECIMAL(20, 2) DEFAULT 0,
    total_crowdfunding_count INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (space_id)
);

CREATE TABLE IF NOT EXISTS user_stats_new (
    space_id VARCHAR(100) NOT NULL,
    user_id VARCHAR(66) NOT NULL,
    total_sent DECIMAL(20, 2) DEFAULT 0,
    total_received DECIMAL(20, 2) DEFAULT 0,
    tips_sent INTEGER DEFAULT 0,
    tips_received INTEGER DEFAULT 0,
    donations INTEGER DEFAULT 0,
    display_name VARCHAR(255),
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (space_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_cooldowns_new (
    space_id VARCHAR(100) NOT NULL,
    user_id VARCHAR(66) NOT NULL,
    command VARCHAR(50) NOT NULL,
    last_used TIMESTAMP NOT NULL,
    PRIMARY KEY (space_id, user_id, command)
);

CREATE TABLE IF NOT EXISTS pending_transactions_new (
    id VARCHAR(100) PRIMARY KEY,
    space_id VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL,
    user_id VARCHAR(66) NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Step 4: Migrate data
-- Use a default space_id for all existing data
-- You should replace 'DEFAULT_SPACE_ID' with your actual space_id if you have one
LET default_space_id = '0x7d43a7907883f99842940214052b1d268de8f5c1';

-- Migrate global_stats
INSERT INTO global_stats_new (space_id, total_tips_volume, total_tips_count, total_donations_volume, total_donations_count, total_crowdfunding_volume, total_crowdfunding_count, updated_at)
SELECT 
    'DEFAULT_SPACE_ID',
    total_tips_volume,
    total_tips_count,
    total_donations_volume,
    total_donations_count,
    total_crowdfunding_volume,
    total_crowdfunding_count,
    updated_at
FROM global_stats;

-- Migrate user_stats
INSERT INTO user_stats_new (space_id, user_id, total_sent, total_received, tips_sent, tips_received, donations, display_name, updated_at)
SELECT 
    'DEFAULT_SPACE_ID',
    user_id,
    total_sent,
    total_received,
    tips_sent,
    tips_received,
    donations,
    display_name,
    updated_at
FROM user_stats;

-- Migrate user_cooldowns
INSERT INTO user_cooldowns_new (space_id, user_id, command, last_used)
SELECT 
    'DEFAULT_SPACE_ID',
    user_id,
    command,
    last_used
FROM user_cooldowns;

-- Migrate pending_transactions
INSERT INTO pending_transactions_new (id, space_id, type, user_id, data, created_at)
SELECT 
    id,
    'DEFAULT_SPACE_ID',
    type,
    user_id,
    data,
    created_at
FROM pending_transactions;

-- Step 5: Rename old tables and new tables
ALTER TABLE global_stats RENAME TO global_stats_old;
ALTER TABLE global_stats_new RENAME TO global_stats;

ALTER TABLE user_stats RENAME TO user_stats_old;
ALTER TABLE user_stats_new RENAME TO user_stats;

ALTER TABLE user_cooldowns RENAME TO user_cooldowns_old;
ALTER TABLE user_cooldowns_new RENAME TO user_cooldowns;

ALTER TABLE pending_transactions RENAME TO pending_transactions_old;
ALTER TABLE pending_transactions_new RENAME TO pending_transactions;

-- Step 6: Verify migration
SELECT 'Global Stats Count:' as check_name, COUNT(*) FROM global_stats;
SELECT 'User Stats Count:' as check_name, COUNT(*) FROM user_stats;
SELECT 'User Cooldowns Count:' as check_name, COUNT(*) FROM user_cooldowns;
SELECT 'Pending Transactions Count:' as check_name, COUNT(*) FROM pending_transactions;

-- Step 7: After verification, you can drop old tables (optional)
-- DROP TABLE global_stats_old;
-- DROP TABLE user_stats_old;
-- DROP TABLE user_cooldowns_old;
-- DROP TABLE pending_transactions_old;

-- Keep backups for safety
-- backup tables are still available in *_backup tables
