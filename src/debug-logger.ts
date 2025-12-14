// Debug logger with timestamps and detailed tracking

export function debugLog(location: string, message: string, data?: any) {
    const timestamp = new Date().toISOString()
    const logMsg = `[${timestamp}] [DEBUG:${location}] ${message}`
    
    if (data !== undefined) {
        console.log(logMsg, JSON.stringify(data, null, 2))
    } else {
        console.log(logMsg)
    }
}

export function debugError(location: string, message: string, error: any) {
    const timestamp = new Date().toISOString()
    console.error(`[${timestamp}] [ERROR:${location}] ${message}`, error)
}

// RPC activity tracker
let lastRpcCall = Date.now()
let rpcCallCount = 0
let lastRpcSuccess = Date.now()

export function trackRpcCall() {
    rpcCallCount++
    lastRpcCall = Date.now()
    debugLog('RPC', `RPC call #${rpcCallCount}`, {
        timeSinceLastCall: Date.now() - lastRpcCall,
        timeSinceLastSuccess: Date.now() - lastRpcSuccess
    })
}

export function trackRpcSuccess() {
    lastRpcSuccess = Date.now()
    debugLog('RPC', 'RPC SUCCESS', { callNumber: rpcCallCount })
}

export function trackRpcError(error: any) {
    debugError('RPC', 'RPC ERROR', error)
}

// Health monitor - logs status every minute
export function startHealthMonitor() {
    setInterval(() => {
        const timeSinceLastRpc = Date.now() - lastRpcCall
        const timeSinceSuccess = Date.now() - lastRpcSuccess
        
        debugLog('HEALTH', 'Health check', {
            totalRpcCalls: rpcCallCount,
            timeSinceLastRpc: `${(timeSinceLastRpc / 1000).toFixed(1)}s`,
            timeSinceLastSuccess: `${(timeSinceSuccess / 1000).toFixed(1)}s`,
            isHealthy: timeSinceSuccess < 180000 // 3 minutes
        })
        
        if (timeSinceSuccess > 300000) { // 5 minutes
            debugError('HEALTH', 'RPC appears to be stuck - no successful calls for 5+ minutes', {
                lastSuccessAt: new Date(lastRpcSuccess).toISOString()
            })
        }
    }, 60000) // Every minute
}
