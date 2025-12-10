# 🚀 Proposal: Preventing Duplicate Form Submissions from Cache

**To:** Towns Protocol Team  
**From:** TipsoBot Developer  
**Date:** December 10, 2025  
**Issue:** Users can resubmit cached form confirmations after page refresh, causing duplicate blockchain transactions

---

## Problem Description

### Current Behavior

There are **TWO forms** in the transaction flow:

**Form #1: Confirmation Dialog (from bot)**
```
1. Bot sends form with buttons [Confirm] [Cancel]
2. User clicks [Confirm]
3. Bot calls removeEvent() to delete this form ✅
4. Bot sends blockchain transaction request...
```

**Form #2: Submit Transaction (from Towns Protocol)**
```
5. Towns shows "Submit transaction" form
6. User clicks [Submit transaction] → blockchain transaction is sent
7. Bot calls removeEvent() to delete this form ✅
8. Transaction completes successfully
```

**The Problem:**
```
9. User refreshes page (F5)
10. Towns restores BOTH forms from **local browser cache** ❌
11. User clicks [Submit transaction] again from cache
12. **Second blockchain transaction is sent to blockchain** ❌
13. Bot detects duplicate and rejects it (safety check)
14. But transaction was already submitted to network!
```

### Real-World Evidence

From TipsoBot production logs:
```
07:45:43 - User clicks Confirm → Form deleted with removeEvent ✅
07:45:55 - Transaction processed → Form deleted with removeEvent ✅
07:46:36 - User clicks Submit transaction AGAIN (from cache) ❌
          - Transaction SENT to blockchain again
          - Duplicate detection blocked it
          - But network call was made!
```

### Impact

- ❌ Users can accidentally double-submit transactions from cached forms
- ❌ Blockchain transactions sent twice (wasting gas/network resources)
- ❌ Bot's `removeEvent()` works on server, but client cache is NOT invalidated
- ❌ Duplicate detection is last line of defense (should not be needed)
- ❌ Users trust is damaged when cached buttons still work

### Root Cause

**Towns client caches form UI elements locally but doesn't invalidate cache when `removeEvent()` is called.**

The server correctly removes the event, but:
1. Client cache is NOT synchronized with server
2. After page refresh, forms are restored from stale cache
3. No mechanism to mark a form as "processed" or "expired" in cache
4. `removeEvent()` has no way to trigger cache invalidation

---

## Proposed Solutions

### ✅ Solution 1: Cache Invalidation on removeEvent() (RECOMMENDED)

**Who implements:** Towns client-side
**Complexity:** Medium
**Effectiveness:** ⭐⭐⭐⭐⭐ (10/10)

**How it works:**
```
1. Bot calls handler.removeEvent(channelId, messageId)
2. Server deletes event ✅
3. Towns client receives removeEvent callback
4. Towns DELETES this message from local browser cache ✅
5. Page refresh → cached message is gone → no duplicate ✅
```

**Alternative trigger points:**
```
// Also invalidate cache when:
- Transaction status === "confirmed"
- Event is redacted/removed
- Form is marked as processed/expired
```

**Implementation notes:**
- Sync cache with server state on `removeEvent()` calls
- When server confirms event deletion, purge from IndexedDB/localStorage
- Add TTL for cached forms (auto-expire after 24-48h)
- Track transaction states to prevent re-submission

**Bot impact:** None - works with existing `removeEvent()` calls

---

### ✅ Solution 2: Idempotency Key / Nonce System

**Who implements:** Towns + bots  
**Complexity:** Medium  
**Effectiveness:** ⭐⭐⭐⭐☆ (9/10)

**How it works:**
```typescript
// Bot sends:
form: {
  id: "donate-ABC123",
  nonce: "unique-uuid-12345"
}

// First submission:
Towns sends nonce with transaction → Towns tracks it

// Second submission (from cache):
Same nonce → Towns detects duplicate
Return error: "Transaction already submitted with this nonce"
Don't send to blockchain ✅
```

**Implementation notes:**
- Add `nonce` field to form request
- Track used nonces per user/form
- TTL for nonces (24-48 hours)

**Bot changes needed:**
```typescript
const nonce = crypto.randomUUID()
await handler.sendInteractionRequest(channel, {
  case: 'form',
  value: {
    id: 'donate-...',
    nonce: nonce,  // ← ADD THIS
    // ... rest of form
  }
})
```

---

### ✅ Solution 3: Form Expiration / State Tracking

**Who implements:** Towns  
**Complexity:** Low-Medium  
**Effectiveness:** ⭐⭐⭐⭐☆ (8/10)

**How it works:**
```typescript
// Towns tracks form state:
forms: Map<formId, {
  status: 'pending' | 'submitted' | 'confirmed' | 'expired',
  expiresAt: timestamp,
  submittedAt?: timestamp,
  confirmedAt?: timestamp
}>

// When user clicks button on expired/confirmed form:
if (form.status === 'confirmed') {
  showWarning("This transaction was already processed")
  return  // Don't submit again
}
```

**Implementation notes:**
- Add form lifecycle tracking
- Mark forms as confirmed after transaction receipt
- Auto-expire forms after 24-48h

**Bot impact:** Minimal - bots can optionally query form state

---

### ✅ Solution 4: API Method for Cache Invalidation

**Who implements:** Towns + bots (optional)  
**Complexity:** Low  
**Effectiveness:** ⭐⭐⭐☆☆ (7/10)

**How it works:**
```typescript
// Bot can explicitly delete cached message:
await handler.deleteMessage(channelId, messageId)
// or
await handler.invalidateCache(messageId)

// Towns removes from browser cache
// Page refresh → message is gone
```

**Implementation notes:**
- Add `deleteMessage()` or `invalidateCache()` to BotHandler API
- Trigger after successful transaction callback
- Bot controls when to invalidate

**Bot changes needed:**
```typescript
// After transaction processes successfully:
await handler.invalidateCache(messageId)
// Message deleted from cache → no duplicate risk
```

---

## Comparison Matrix

| Aspect | Solution 1 | Solution 2 | Solution 3 | Solution 4 |
|--------|-----------|-----------|-----------|----------|
| **Implementation effort** | Medium | Medium | Low-Med | Low |
| **Effectiveness** | 10/10 | 9/10 | 8/10 | 7/10 |
| **Bot changes needed** | None | Yes | Optional | Yes |
| **Backwards compatible** | Yes | Yes* | Yes | Yes |
| **Can implement now** | Yes | Yes | Yes | Yes |
| **Long-term solution** | Yes | Yes | Yes | Yes |
| **User experience** | Best | Good | Good | Good |

*Solution 2 needs bot adoption to work effectively

---

## Recommendation

**Implement Solution 1 (Cache Invalidation) as primary fix:**
- ✅ Solves problem immediately
- ✅ Zero bot changes needed
- ✅ Works for all current bots automatically
- ✅ Best user experience
- ✅ No backwards compatibility issues

**Then add Solution 2 (Nonce) as secondary safeguard:**
- Additional defense layer
- Bots can gradually adopt
- Provides transaction-level guarantee

---

## Impact

### On Users
- ✅ No more double transactions
- ✅ Better trust in bots
- ✅ Cleaner transaction history

### On Bot Developers
- ✅ No need to implement duplicate detection
- ✅ Simpler, cleaner code
- ✅ Can focus on features instead of safety

### On Towns Protocol
- ✅ More reliable and trustworthy
- ✅ Attracts more bot developers
- ✅ Better adoption across ecosystem

---

## Questions / Notes

1. **Q:** How is cache currently invalidated for other events?  
   **A:** Could follow same pattern for forms

2. **Q:** Would Solution 1 impact performance?  
   **A:** Minimal - just tracking transaction states

3. **Q:** Backward compatibility?  
   **A:** All solutions are backwards compatible

4. **Q:** Timeline?  
   **A:** Solution 1 could be implemented in one sprint

---

## Appendix: Current Workaround (What Bots Do Today)

### TipsoBot's Implementation (4 layers of defense)

**Layer 1: Try to delete forms**
```typescript
// After user clicks button or transaction completes
await handler.removeEvent(channelId, messageId)
// ❌ Doesn't work - client cache not invalidated
```

**Layer 2: Check status before processing**
```typescript
// In handleFormResponse (when Confirm clicked)
if (pendingTx.status === 'processed') {
    return "⚠️ This transaction was already completed"
}
// ⚠️ Partial protection - only catches Confirm button
```

**Layer 3: Duplicate detection in database**
```typescript
// In handleTransactionResponse (when blockchain confirms)
const tx = await getPendingTransaction(requestId)
if (tx.status === 'processed') {
    console.log('🛑 DUPLICATE! Ignoring...')
    return
}
// ✅ Works but transaction already sent to blockchain!
```

**Layer 4: Keep processed transactions for 7 days**
```sql
-- Don't delete, just mark as processed
UPDATE pending_transactions
SET status = 'processed'
WHERE id = $1

-- Cleanup old records after 7 days
DELETE FROM pending_transactions
WHERE created_at < NOW() - INTERVAL '7 days'
```

### The Problem

Even with ALL 4 layers:
- ❌ Cached forms still appear after refresh
- ❌ Blockchain transactions are sent twice (Layer 3 catches it, but too late)
- ❌ Complex database architecture needed
- ❌ Every bot must implement this
- ❌ Still a race condition window

### Why This Should Be in Towns

1. **Security:** Duplicate prevention is a platform concern
2. **DX:** Bot developers shouldn't need 4 layers of protection
3. **Performance:** Wasted blockchain calls for duplicate detection
4. **Consistency:** Every bot implements this differently
5. **Trust:** Users expect forms to disappear after use

**This workaround is a band-aid. The real fix belongs in Towns Protocol.**

---

**Contact:** TipsoBot team  
**Status:** Open for discussion
