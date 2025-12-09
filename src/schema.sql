-- TipsoBot PostgreSQL Schema

-- Global bot statistics (per space/town)
CREATE TABLE IF NOT EXISTS global_stats (
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

-- User statistics (per space/town)
CREATE TABLE IF NOT EXISTS user_stats (
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

-- Payment requests for crowdfunding
CREATE TABLE IF NOT EXISTS payment_requests (
    id VARCHAR(100) PRIMARY KEY,
    space_id VARCHAR(100) NOT NULL,
    creator_id VARCHAR(66) NOT NULL,
    creator_name VARCHAR(255) NOT NULL,
    amount DECIMAL(20, 2) NOT NULL,
    description TEXT NOT NULL,
    total_collected DECIMAL(20, 2) DEFAULT 0,
    channel_id VARCHAR(100) NOT NULL,
    is_completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Contributions to payment requests
CREATE TABLE IF NOT EXISTS contributions (
    id SERIAL PRIMARY KEY,
    request_id VARCHAR(100) NOT NULL REFERENCES payment_requests(id),
    contributor_id VARCHAR(66) NOT NULL,
    contributor_name VARCHAR(255),
    amount DECIMAL(20, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- User cooldowns for rate limiting
CREATE TABLE IF NOT EXISTS user_cooldowns (
    space_id VARCHAR(100) NOT NULL,
    user_id VARCHAR(66) NOT NULL,
    command VARCHAR(50) NOT NULL,
    last_used TIMESTAMP NOT NULL,
    PRIMARY KEY (space_id, user_id, command)
);

-- Pending transactions (waiting for confirmation)
CREATE TABLE IF NOT EXISTS pending_transactions (
    id VARCHAR(100) PRIMARY KEY,
    space_id VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL, -- 'tip', 'tipsplit', 'donate', 'contribute'
    user_id VARCHAR(66) NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_stats_space_sent ON user_stats(space_id, total_sent DESC);
CREATE INDEX IF NOT EXISTS idx_user_stats_space_received ON user_stats(space_id, total_received DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_space ON payment_requests(space_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_channel ON payment_requests(channel_id);
CREATE INDEX IF NOT EXISTS idx_contributions_request ON contributions(request_id);
CREATE INDEX IF NOT EXISTS idx_user_cooldowns_lookup ON user_cooldowns(space_id, user_id, command);
CREATE INDEX IF NOT EXISTS idx_pending_tx_space ON pending_transactions(space_id);
CREATE INDEX IF NOT EXISTS idx_pending_tx_created ON pending_transactions(created_at);
