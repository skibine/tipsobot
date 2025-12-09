import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

// PostgreSQL connection pool
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
})

// Initialize database schema
export async function initDatabase() {
    try {
        console.log('[DB] Initializing database schema...')
        const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8')
        await pool.query(schema)
        console.log('[DB] Database schema initialized successfully')
    } catch (error) {
        console.error('[DB] Failed to initialize database:', error)
        throw error
    }
}

// Global Stats Functions (per space/town)
export async function getGlobalStats(spaceId: string) {
    const result = await pool.query(
        'SELECT * FROM global_stats WHERE space_id = $1',
        [spaceId]
    )
    return result.rows[0] || {
        space_id: spaceId,
        total_tips_volume: 0,
        total_tips_count: 0,
        total_donations_volume: 0,
        total_donations_count: 0,
        total_crowdfunding_volume: 0,
        total_crowdfunding_count: 0
    }
}

export async function updateGlobalStats(spaceId: string, stats: {
    tipsVolume?: number
    tipsCount?: number
    donationsVolume?: number
    donationsCount?: number
    crowdfundingVolume?: number
    crowdfundingCount?: number
}) {
    const updates: string[] = []
    const values: any[] = [spaceId]
    let paramIndex = 2

    if (stats.tipsVolume !== undefined) {
        updates.push(`total_tips_volume = total_tips_volume + $${paramIndex++}`)
        values.push(stats.tipsVolume)
    }
    if (stats.tipsCount !== undefined) {
        updates.push(`total_tips_count = total_tips_count + $${paramIndex++}`)
        values.push(stats.tipsCount)
    }
    if (stats.donationsVolume !== undefined) {
        updates.push(`total_donations_volume = total_donations_volume + $${paramIndex++}`)
        values.push(stats.donationsVolume)
    }
    if (stats.donationsCount !== undefined) {
        updates.push(`total_donations_count = total_donations_count + $${paramIndex++}`)
        values.push(stats.donationsCount)
    }
    if (stats.crowdfundingVolume !== undefined) {
        updates.push(`total_crowdfunding_volume = total_crowdfunding_volume + $${paramIndex++}`)
        values.push(stats.crowdfundingVolume)
    }
    if (stats.crowdfundingCount !== undefined) {
        updates.push(`total_crowdfunding_count = total_crowdfunding_count + $${paramIndex++}`)
        values.push(stats.crowdfundingCount)
    }

    if (updates.length === 0) return

    updates.push('updated_at = NOW()')

    // Ensure row exists
    await pool.query(
        'INSERT INTO global_stats (space_id) VALUES ($1) ON CONFLICT (space_id) DO NOTHING',
        [spaceId]
    )

    await pool.query(
        `UPDATE global_stats SET ${updates.join(', ')} WHERE space_id = $1`,
        values
    )
}

// User Stats Functions (per space/town)
export async function getUserStats(spaceId: string, userId: string) {
    const result = await pool.query(
        'SELECT * FROM user_stats WHERE space_id = $1 AND user_id = $2',
        [spaceId, userId]
    )
    return result.rows[0] || null
}

export async function upsertUserStats(
    spaceId: string,
    userId: string,
    displayName: string,
    stats: {
        sentAmount?: number
        receivedAmount?: number
        tipsSent?: number
        tipsReceived?: number
        donations?: number
    }
) {
    const updates: string[] = []
    const values: any[] = [spaceId, userId, displayName]
    let paramIndex = 4

    if (stats.sentAmount !== undefined) {
        updates.push(`total_sent = user_stats.total_sent + $${paramIndex++}`)
        values.push(stats.sentAmount)
    }
    if (stats.receivedAmount !== undefined) {
        updates.push(`total_received = user_stats.total_received + $${paramIndex++}`)
        values.push(stats.receivedAmount)
    }
    if (stats.tipsSent !== undefined) {
        updates.push(`tips_sent = user_stats.tips_sent + $${paramIndex++}`)
        values.push(stats.tipsSent)
    }
    if (stats.tipsReceived !== undefined) {
        updates.push(`tips_received = user_stats.tips_received + $${paramIndex++}`)
        values.push(stats.tipsReceived)
    }
    if (stats.donations !== undefined) {
        updates.push(`donations = user_stats.donations + $${paramIndex++}`)
        values.push(stats.donations)
    }

    updates.push('updated_at = NOW()')

    await pool.query(
        `INSERT INTO user_stats (space_id, user_id, display_name, total_sent, total_received, tips_sent, tips_received, donations)
         VALUES ($1, $2, $3, 0, 0, 0, 0, 0)
         ON CONFLICT (space_id, user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         ${updates.join(', ')}`,
        values
    )
}

// Leaderboard Functions (per space/town)
export async function getTopTippers(spaceId: string, limit: number = 10) {
    const result = await pool.query(
        `SELECT user_id, display_name, total_sent as amount, tips_sent as count
         FROM user_stats
         WHERE space_id = $1 AND tips_sent > 0
         ORDER BY total_sent DESC
         LIMIT $2`,
        [spaceId, limit]
    )
    return result.rows
}

export async function getTopDonators(spaceId: string, limit: number = 10) {
    const result = await pool.query(
        `SELECT user_id, display_name, total_sent as amount, donations as count
         FROM user_stats
         WHERE space_id = $1 AND donations > 0
         ORDER BY total_sent DESC, donations DESC
         LIMIT $2`,
        [spaceId, limit]
    )
    return result.rows
}

// Payment Request Functions
export async function createPaymentRequest(data: {
    id: string
    spaceId: string
    creatorId: string
    creatorName: string
    amount: number
    description: string
    channelId: string
}) {
    await pool.query(
        `INSERT INTO payment_requests (id, space_id, creator_id, creator_name, amount, description, channel_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [data.id, data.spaceId, data.creatorId, data.creatorName, data.amount, data.description, data.channelId]
    )
}

export async function getPaymentRequest(id: string) {
    const result = await pool.query(
        'SELECT * FROM payment_requests WHERE id = $1',
        [id]
    )
    return result.rows[0] || null
}

export async function addContribution(data: {
    requestId: string
    contributorId: string
    contributorName: string
    amount: number
}) {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        // Add contribution
        await client.query(
            `INSERT INTO contributions (request_id, contributor_id, contributor_name, amount)
             VALUES ($1, $2, $3, $4)`,
            [data.requestId, data.contributorId, data.contributorName, data.amount]
        )

        // Update payment request total
        const result = await client.query(
            `UPDATE payment_requests
             SET total_collected = total_collected + $1,
                 is_completed = (total_collected + $1) >= amount,
                 completed_at = CASE WHEN (total_collected + $1) >= amount AND completed_at IS NULL
                                     THEN NOW() ELSE completed_at END
             WHERE id = $2
             RETURNING *`,
            [data.amount, data.requestId]
        )

        await client.query('COMMIT')
        return result.rows[0]
    } catch (error) {
        await client.query('ROLLBACK')
        throw error
    } finally {
        client.release()
    }
}

export async function getContributions(requestId: string) {
    const result = await pool.query(
        'SELECT * FROM contributions WHERE request_id = $1 ORDER BY created_at DESC',
        [requestId]
    )
    return result.rows
}

// Cooldown Functions (per space/town)
export async function checkCooldown(spaceId: string, userId: string, command: string, cooldownMs: number): Promise<boolean> {
    const result = await pool.query(
        `SELECT last_used FROM user_cooldowns WHERE space_id = $1 AND user_id = $2 AND command = $3`,
        [spaceId, userId, command]
    )

    if (result.rows.length === 0) {
        return true // No cooldown record, allowed
    }

    const lastUsed = new Date(result.rows[0].last_used).getTime()
    const now = Date.now()
    return (now - lastUsed) >= cooldownMs
}

export async function updateCooldown(spaceId: string, userId: string, command: string) {
    await pool.query(
        `INSERT INTO user_cooldowns (space_id, user_id, command, last_used)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (space_id, user_id, command) DO UPDATE SET last_used = NOW()`,
        [spaceId, userId, command]
    )
}

export async function getRemainingCooldown(spaceId: string, userId: string, command: string, cooldownMs: number): Promise<number> {
    const result = await pool.query(
        `SELECT last_used FROM user_cooldowns WHERE space_id = $1 AND user_id = $2 AND command = $3`,
        [spaceId, userId, command]
    )

    if (result.rows.length === 0) {
        return 0
    }

    const lastUsed = new Date(result.rows[0].last_used).getTime()
    const now = Date.now()
    const remaining = cooldownMs - (now - lastUsed)
    return Math.max(0, remaining)
}

// Pending Transactions Functions (per space/town)
export async function savePendingTransaction(
    spaceId: string,
    id: string,
    type: string,
    userId: string,
    data: any,
    messageId?: string,
    channelId?: string
) {
    await pool.query(
        `INSERT INTO pending_transactions (space_id, id, type, user_id, data, message_id, channel_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, message_id = EXCLUDED.message_id, channel_id = EXCLUDED.channel_id`,
        [spaceId, id, type, userId, JSON.stringify(data), messageId || null, channelId || null]
    )
}

export async function getPendingTransaction(id: string) {
    const result = await pool.query(
        'SELECT * FROM pending_transactions WHERE id = $1',
        [id]
    )
    if (result.rows.length === 0) return null
    const row = result.rows[0]
    return {
        id: row.id,
        spaceId: row.space_id,
        type: row.type,
        userId: row.user_id,
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
        messageId: row.message_id,
        channelId: row.channel_id,
        status: row.status,
        createdAt: row.created_at
    }
}

export async function updatePendingTransaction(id: string, data: any) {
    await pool.query(
        'UPDATE pending_transactions SET data = $1 WHERE id = $2',
        [JSON.stringify(data), id]
    )
}

export async function updatePendingTransactionStatus(id: string, status: 'pending' | 'processed' | 'failed') {
    await pool.query(
        'UPDATE pending_transactions SET status = $1 WHERE id = $2',
        [status, id]
    )
}

export async function deletePendingTransaction(id: string) {
    await pool.query('DELETE FROM pending_transactions WHERE id = $1', [id])
}

// Cleanup old pending transactions (older than 1 hour)
export async function cleanupOldTransactions() {
    await pool.query(
        `DELETE FROM pending_transactions WHERE created_at < NOW() - INTERVAL '1 hour'`
    )
}

// Graceful shutdown
export async function closeDatabase() {
    await pool.end()
    console.log('[DB] Database connection closed')
}
