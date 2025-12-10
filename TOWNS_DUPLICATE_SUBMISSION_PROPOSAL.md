# 🚀 Proposal: Fix Cache Invalidation for Interactive Forms

**To:** Towns Protocol Team
**From:** Bot Developer Community
**Date:** December 10, 2025
**Issue:** Interactive forms sent via `sendInteractionRequest()` are not removed from client cache when `removeEvent()` is called

---

## Problem Description

### The Architectural Issue

Towns Protocol has **two different message types** with **different caching behavior**:

| Method | Use Case | Cache Invalidation | Supports Buttons |
|--------|----------|-------------------|-----------------|
| `sendMessage()` | Text, images, links | ✅ Works correctly | ❌ No |
| `sendInteractionRequest()` | Forms with buttons | ❌ **BROKEN** | ✅ Yes |

**The problem:**
- Interactive buttons can ONLY be sent via `sendInteractionRequest()`
- But `removeEvent()` does NOT invalidate the cache for these messages
- Result: Cached forms reappear after page refresh and remain clickable

### Why This Happens

```typescript
// ✅ THIS WORKS: Normal messages
await handler.sendMessage(channelId, "✅ Success!")
const result = await handler.sendMessage(...)
await handler.removeEvent(channelId, result.eventId)
// → Server deletes event
// → Client cache is invalidated
// → After F5: message is gone ✅

// ❌ THIS DOESN'T WORK: Interactive forms
await handler.sendInteractionRequest(channelId, {
  case: 'form',
  value: {
    id: "confirm-123",
    title: "Confirm action?",
    components: [
      { id: 'confirm', component: { case: 'button', value: { label: 'Confirm' } } }
    ]
  }
})
await handler.removeEvent(channelId, eventId)
// → Server deletes event ✅
// → Client cache is NOT invalidated ❌
// → After F5: form returns from cache and buttons still work! ❌
```

### Root Cause

1. **Interactive forms use a separate storage mechanism** (interaction store vs message store)
2. **`removeEvent()` only invalidates message store cache**, not interaction store
3. **Buttons cannot be sent via `sendMessage()`** - API limitation
4. **Result:** Any bot that uses buttons is affected by this bug

This is not a bot implementation issue - **it's an architectural gap in Towns Protocol**.

---

## Real-World Evidence

From production bots using interactive forms:

```
Timeline:
07:45:43 - User clicks [Confirm] button
07:45:44 - Bot calls removeEvent() → Server: ✅ Success
07:45:45 - Bot sends transaction request
07:45:55 - User submits transaction
07:45:56 - Bot calls removeEvent() → Server: ✅ Success
07:46:36 - User refreshes page (F5)
           ↳ Form reappears from cache ❌
07:46:40 - User clicks [Submit transaction] AGAIN from cached form
           ↳ Second blockchain transaction sent to network ❌
           ↳ Bot detects duplicate and blocks it
           ↳ But network call was already made!
```

---

## Who Is Affected?

**Any bot that uses interactive buttons for important or irreversible actions:**

### Financial/Payment Bots
- Tip bots (like TipsoBot)
- NFT purchase bots
- DeFi transaction bots
- Crowdfunding bots
- Payment request bots

### Action Confirmation Bots
- Voting/governance bots
- Role assignment bots
- Reward distribution bots
- Airdrop claim bots

### Resource Management Bots
- Whitelist/allowlist bots
- Booking/reservation bots
- Ticket purchase bots
- Limited resource allocation

### Gaming/Betting Bots
- In-game purchases
- Betting/wagering
- Loot box opening
- Any irreversible game action

**Impact:** Every bot using `sendInteractionRequest()` must implement complex duplicate detection workarounds.

---

## Current Workaround (Required by ALL Bots)

Since `removeEvent()` doesn't work for interactive forms, bots must:

### 1. Implement Transaction State Tracking
```typescript
// Store transaction status in database
const pendingTx = {
  id: "tx-123",
  status: 'pending' | 'processed' | 'failed',
  createdAt: timestamp
}
```

### 2. Check Status Before Processing
```typescript
// When user clicks cached button
if (pendingTx.status === 'processed') {
    return "⚠️ This was already completed"
}
// ⚠️ Partial protection - doesn't prevent blockchain call
```

### 3. Detect Duplicates After Blockchain Call
```typescript
// After transaction callback received
if (tx.status === 'processed') {
    console.log('Duplicate! Ignoring...')
    return
}
// ✅ Works, but blockchain transaction was already sent!
// ⚠️ Wastes gas and network resources
```

### 4. Keep Transaction History
```sql
-- Can't delete processed transactions
-- Must keep for 7+ days to detect cached button clicks
UPDATE transactions SET status = 'processed'
WHERE id = $1

-- Cleanup only after long retention period
DELETE FROM transactions
WHERE created_at < NOW() - INTERVAL '7 days'
```

### Why This Is a Problem

- ❌ **Complex:** Every bot must implement this independently
- ❌ **Wasteful:** Blockchain transactions sent twice (caught late)
- ❌ **Error-prone:** Easy to implement incorrectly
- ❌ **Bad UX:** Cached forms still appear and work after refresh
- ❌ **Platform issue:** This should be handled by Towns, not every bot

**Bot developers shouldn't need to work around client-side cache bugs.**

---

## Proposed Solutions

### ✅ Solution 1: Fix Cache Invalidation for `removeEvent()` (RECOMMENDED)

**Who implements:** Towns Protocol (client-side)
**Complexity:** Medium
**Effectiveness:** ⭐⭐⭐⭐⭐ (10/10)

**How it works:**
```
1. Bot calls handler.removeEvent(channelId, eventId)
2. Server deletes event ✅
3. Server sends cache invalidation signal to client
4. Client deletes event from BOTH message store AND interaction store ✅
5. Page refresh → event is gone → no duplicates ✅
```

**Implementation:**
- When `removeEvent()` succeeds, invalidate **both** storage mechanisms
- Remove from IndexedDB/localStorage for interaction forms
- Sync client cache with server state on removeEvent/redaction events
- Add TTL for cached forms (auto-expire after 24-48h)

**Bot changes needed:** None - works with existing code

---

### ✅ Solution 2: Add Button Support to `sendMessage()`

**Who implements:** Towns Protocol (API)
**Complexity:** High
**Effectiveness:** ⭐⭐⭐⭐⭐ (10/10)

**How it works:**
```typescript
// Allow buttons in sendMessage
await handler.sendMessage(channelId, "Confirm action?", {
  attachments: [{
    type: 'buttons',  // ← NEW attachment type
    buttons: [
      { id: 'confirm', label: 'Confirm' },
      { id: 'cancel', label: 'Cancel' }
    ]
  }]
})

// Now buttons use message store → removeEvent() works! ✅
```

**Implementation:**
- Add `buttons` attachment type to `PostMessageOpts`
- Store button forms in message store (same as text messages)
- Leverage existing cache invalidation mechanism
- `removeEvent()` works automatically

**Bot changes needed:**
- Migrate from `sendInteractionRequest` to `sendMessage` with button attachments
- Backwards compatible - can support both APIs

---

### ✅ Solution 3: Transaction Idempotency / Nonce System

**Who implements:** Towns Protocol + bots
**Complexity:** Medium
**Effectiveness:** ⭐⭐⭐⭐☆ (9/10)

**How it works:**
```typescript
// Bot sends with nonce
await handler.sendInteractionRequest(channel, {
  case: 'form',
  value: {
    id: 'confirm-123',
    nonce: crypto.randomUUID(),  // ← Add nonce
    // ...
  }
})

// Towns tracks used nonces
// Second submission with same nonce → rejected before blockchain call
```

**Implementation:**
- Add `nonce` field to interaction requests
- Track used nonces per user (24-48h TTL)
- Reject duplicate nonces BEFORE sending blockchain transactions
- Return error: "Already submitted"

**Bot changes needed:** Add nonce generation

---

### ✅ Solution 4: Form State Tracking in Towns

**Who implements:** Towns Protocol
**Complexity:** Low-Medium
**Effectiveness:** ⭐⭐⭐⭐☆ (8/10)

**How it works:**
```typescript
// Towns tracks form lifecycle
forms: Map<formId, {
  status: 'pending' | 'submitted' | 'confirmed' | 'expired',
  expiresAt: timestamp
}>

// When user clicks cached button
if (form.status === 'confirmed' || form.status === 'expired') {
  showWarning("This form is no longer valid")
  return  // Don't submit
}
```

**Implementation:**
- Track form states in Towns Protocol
- Mark forms as expired after transaction confirmation
- Auto-expire forms after 24-48h
- Disable cached buttons for expired forms

**Bot changes needed:** Optional - can query form state

---

## Comparison Matrix

| Aspect | Solution 1 | Solution 2 | Solution 3 | Solution 4 |
|--------|-----------|-----------|-----------|----------|
| **Fixes root cause** | Yes | Yes | No (workaround) | Partial |
| **Implementation effort** | Medium | High | Medium | Low-Med |
| **Effectiveness** | 10/10 | 10/10 | 9/10 | 8/10 |
| **Bot changes needed** | None | Optional | Yes | Optional |
| **Backwards compatible** | Yes | Yes | Yes | Yes |
| **User experience** | Best | Best | Good | Good |
| **Works immediately** | Yes | No (migration) | Yes | Yes |

---

## Recommendation

**Primary: Solution 1 (Fix Cache Invalidation)**
- ✅ Fixes root cause immediately
- ✅ Zero bot changes needed
- ✅ Works for all existing bots
- ✅ Best user experience

**Long-term: Solution 2 (Buttons in sendMessage)**
- ✅ Unifies architecture
- ✅ Simplifies API surface
- ✅ Leverages existing cache mechanism
- ⚠️ Requires bot migration (can be gradual)

**Secondary safeguard: Solution 3 (Nonce System)**
- ✅ Additional protection layer
- ✅ Prevents duplicate blockchain transactions
- ⚠️ Requires bot adoption

---

## Impact of Fixing This

### For Users
- ✅ No more confusing cached buttons after refresh
- ✅ No risk of accidental duplicate transactions
- ✅ Better trust in Towns Protocol bots

### For Bot Developers
- ✅ No complex duplicate detection needed
- ✅ Simpler, cleaner code
- ✅ Can focus on features instead of workarounds
- ✅ Lower barrier to entry for new bots

### For Towns Protocol
- ✅ More reliable and trustworthy platform
- ✅ Attracts more bot developers
- ✅ Consistent behavior across API surface
- ✅ Better developer experience

---

## Technical Details

### Why `removeEvent()` Works for sendMessage but Not sendInteractionRequest

```
sendMessage() flow:
┌─────────────┐
│ Bot calls   │
│ sendMessage │
└──────┬──────┘
       │
       ▼
┌────────────────────┐
│ Message Store      │  ← Regular messages
│ (IndexedDB)        │
└────────────────────┘
       │
       │  removeEvent()
       ▼
┌────────────────────┐
│ Cache invalidated  │  ✅ Works!
└────────────────────┘


sendInteractionRequest() flow:
┌─────────────────────┐
│ Bot calls           │
│ sendInteraction     │
│ Request             │
└──────┬──────────────┘
       │
       ▼
┌────────────────────┐
│ Interaction Store  │  ← Separate storage!
│ (IndexedDB)        │
└────────────────────┘
       │
       │  removeEvent()
       ▼
┌────────────────────┐
│ Cache NOT          │  ❌ Broken!
│ invalidated        │
└────────────────────┘
```

**The fix:** Make `removeEvent()` invalidate **both** stores, not just message store.

---

## Questions / Discussion

1. **Q:** Why not just use `sendMessage()` instead of `sendInteractionRequest()`?
   **A:** Buttons are ONLY available via `sendInteractionRequest()`. API limitation.

2. **Q:** Can bots implement workarounds?
   **A:** Yes (and they do), but it's complex, wasteful, and shouldn't be necessary.

3. **Q:** Would Solution 1 impact performance?
   **A:** Minimal - just syncing cache state with server (already happens for regular messages).

4. **Q:** Backwards compatibility?
   **A:** All solutions maintain backwards compatibility.

5. **Q:** Timeline for fix?
   **A:** Solution 1 could be implemented in 1-2 sprints.

---

**This is a platform-level issue affecting all bots that use interactive forms. It should be fixed in Towns Protocol, not worked around by every bot developer.**

---

**Contact:** Bot Developer Community
**Status:** Open for discussion
**Priority:** High - affects user trust and transaction safety
