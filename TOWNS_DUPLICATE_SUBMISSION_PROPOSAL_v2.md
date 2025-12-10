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
// → Server sends redaction event ✅
// → But redaction DOESN'T recognize InteractionRequest type ❌
// → InteractionRequest event stays in database ❌
// → Client cache is NOT invalidated ❌
// → After F5: form returns from cache and buttons still work! ❌
```

### Root Cause Analysis

**Server-Side Architecture Issue:**

`sendInteractionRequest()` and `sendMessage()` create **different event types** in Towns Protocol:

```typescript
// Regular messages - can be deleted
sendMessage() → ChannelMessage {
  payload: {
    case: 'post' | 'reaction' | 'edit' | 'redaction'  // ✅ Supports deletion
  }
}

// Interactive forms - CANNOT be deleted
sendInteractionRequest() → InteractionRequest {
  recipient: Uint8Array,
  encryptedData: EncryptedMessage,
  threadId?: Uint8Array
}  // ❌ NOT a ChannelMessage!
```

**Why `removeEvent()` doesn't work:**

```typescript
// From Towns bot.ts source code:
const removeEvent = async (streamId, messageId) => {
  const payload = create(ChannelMessageSchema, {
    payload: {
      case: 'redaction',  // ← Only works for ChannelMessage!
      value: { refEventId: messageId }
    }
  })
  return sendMessageEvent({ streamId, payload })
}
```

`removeEvent()` creates a **ChannelMessage with `redaction` payload**, which only works for deleting other ChannelMessages. But `InteractionRequest` is a **completely separate event type** that the redaction mechanism doesn't recognize.

**Key insight:** This is not a cache invalidation bug - it's a **protocol-level type mismatch**. The deletion mechanism (`redaction`) fundamentally cannot delete `InteractionRequest` events because they are different types in the event schema.

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

## Why Bot-Level Solutions Don't Work

When this bug was first discovered, bot developers attempted various workarounds:

**Attempted approach:**
1. Track transaction states in database (pending/processed/failed)
2. Check status before processing button clicks
3. Detect duplicates after blockchain transaction sent
4. Keep long transaction history (7+ days) to catch cached clicks

**Why this fails:**
- ❌ Blockchain transaction is **already sent** before duplicate is detected
- ❌ Wastes network resources and gas on duplicate calls
- ❌ Forms **still appear** in UI after refresh - confusing users
- ❌ Complex infrastructure needed by every bot independently
- ❌ Doesn't address root cause: cached forms remain interactive

**Conclusion:** This is a **protocol-level architecture issue**. The `redaction` mechanism only works for `ChannelMessage` events, but `InteractionRequest` is a separate event type. Bot-level workarounds cannot fix this fundamental type mismatch in the protocol.

---

## Proposed Solutions

### ✅ Solution 1: Add Deletion Support for InteractionRequest Events (RECOMMENDED)

**Who implements:** Towns Protocol (server + client)
**Complexity:** Medium
**Effectiveness:** ⭐⭐⭐⭐⭐ (10/10)

**The Problem:**
Currently, `removeEvent()` creates a `ChannelMessage` with `payload.case = 'redaction'`, which only works for deleting other `ChannelMessage` events. `InteractionRequest` is a separate event type that the redaction mechanism doesn't recognize.

**Proposed Fix:**

Extend the `redaction` payload to support `InteractionRequest` events:

```typescript
// Current (only works for ChannelMessage):
const removeEvent = async (streamId, messageId) => {
  const payload = create(ChannelMessageSchema, {
    payload: {
      case: 'redaction',
      value: { refEventId: messageId }  // Only removes ChannelMessage
    }
  })
  return sendMessageEvent({ streamId, payload })
}

// Proposed fix:
// When redaction is processed, check BOTH:
// 1. ChannelMessage events with matching eventId
// 2. InteractionRequest events with matching eventId
// Delete whichever is found
```

**Implementation options:**

1. **Extend redaction handler** (simplest):
   - When processing `redaction` payload, check both ChannelMessage and InteractionRequest stores
   - Delete the event from whichever store contains it
   - Invalidate client cache for both types

2. **Add InteractionRequest redaction type** (explicit):
   - Add new payload case: `interactionRedaction`
   - `removeEvent()` detects event type and uses appropriate redaction
   - More explicit, but requires API changes

3. **Unify event types** (long-term):
   - Make `InteractionRequest` a payload case within `ChannelMessage`
   - Existing redaction mechanism works automatically
   - Cleaner architecture, but larger refactor

**Bot changes needed:** None - works with existing `removeEvent()` calls

---

### ✅ Solution 2: Transaction Idempotency / Nonce System

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

### ✅ Solution 3: Form State Tracking in Towns

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

| Aspect | Solution 1 | Solution 2 | Solution 3 |
|--------|-----------|-----------|----------|
| **Fixes root cause** | Yes | No (workaround) | Partial |
| **Implementation effort** | Medium | Medium | Low-Med |
| **Effectiveness** | 10/10 | 9/10 | 8/10 |
| **Bot changes needed** | None | Yes | Optional |
| **Backwards compatible** | Yes | Yes | Yes |
| **User experience** | Best | Good | Good |
| **Works immediately** | Yes | Yes | Yes |

---

## Recommendation

**Primary: Solution 1 (Fix Cache Invalidation)**
- ✅ Fixes root cause immediately
- ✅ Zero bot changes needed
- ✅ Works for all existing bots
- ✅ Best user experience
- ✅ Minimal implementation effort

**Secondary safeguard: Solution 2 (Nonce System)**
- ✅ Additional protection layer
- ✅ Prevents duplicate blockchain transactions
- ⚠️ Requires bot adoption
- ⚠️ Doesn't fix root cause (forms still cached)

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
┌────────────────────────┐
│ Creates:               │
│ ChannelMessage event   │
│ with payload.case =    │
│ 'post'                 │
└────────────────────────┘
       │
       │  removeEvent() creates
       │  ChannelMessage with
       │  payload.case = 'redaction'
       ▼
┌────────────────────────┐
│ Redaction recognizes   │
│ ChannelMessage type    │
│ → Event deleted ✅      │
└────────────────────────┘


sendInteractionRequest() flow:
┌─────────────────────────┐
│ Bot calls               │
│ sendInteractionRequest  │
└──────┬──────────────────┘
       │
       ▼
┌────────────────────────┐
│ Creates:               │
│ InteractionRequest     │
│ (NOT ChannelMessage!)  │
└────────────────────────┘
       │
       │  removeEvent() creates
       │  ChannelMessage with
       │  payload.case = 'redaction'
       ▼
┌────────────────────────┐
│ Redaction only works   │
│ for ChannelMessage     │
│ → Type mismatch! ❌     │
│ → Event NOT deleted ❌  │
└────────────────────────┘
```

**The fix:** Extend `redaction` mechanism to recognize and delete `InteractionRequest` events, not just `ChannelMessage` events.

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
