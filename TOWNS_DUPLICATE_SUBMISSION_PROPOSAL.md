# 🚀 Proposal: Preventing Duplicate Form Submissions from Cache

**To:** Towns Protocol Team  
**From:** TipsoBot Developer  
**Date:** December 10, 2025  
**Issue:** Users can resubmit cached form confirmations after page refresh, causing duplicate blockchain transactions

---

## Problem Description

### Current Behavior

1. Bot sends form with buttons [Confirm] [Cancel]
2. User clicks [Confirm] → blockchain transaction is sent (confirmed by Towns)
3. User refreshes page (F5)
4. Towns restores form from **local browser cache**
5. User clicks [Confirm] again → **second blockchain transaction is sent** ❌

### Impact

- Users get double-charged for transactions
- Duplicate events in blockchain
- Bots have no way to prevent this on their side
- Users trust is damaged

### Root Cause

Towns caches form UI elements locally but doesn't invalidate them after successful transactions. The protocol has no built-in mechanism to mark a form as "processed" or "expired."

---

## Proposed Solutions

### ✅ Solution 1: Cache Invalidation After Confirmation (RECOMMENDED)

**Who implements:** Towns client-side  
**Complexity:** Medium  
**Effectiveness:** ⭐⭐⭐⭐⭐ (10/10)

**How it works:**
```
1. User clicks [Submit]
2. Form is sent to blockchain
3. Towns receives transaction confirmation from blockchain
4. Towns DELETES this form from local cache
5. Page refresh → form is gone → no duplicate
```

**Implementation notes:**
- Track transaction state in cache
- When `transaction.status === "confirmed"`, remove form from cache
- Add cleanup for old cached forms (>24h)

**Bot impact:** None - no changes needed

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

## Appendix: Current Workaround

Current bots have to:
1. Save transaction state in database
2. Check if transaction already processed on every callback
3. Manually track processed transactions for 7 days
4. Hope users don't submit duplicates

This should be built into Towns, not every bot.

---

**Contact:** TipsoBot team  
**Status:** Open for discussion
