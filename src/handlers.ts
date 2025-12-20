// Interaction response handlers
import { BotHandler, BasePayload } from '@towns-protocol/bot'
import { hexToBytes, parseEther, formatEther } from 'viem'
import { execute } from 'viem/experimental/erc7821'
import { waitForTransactionReceipt } from 'viem/actions'
import {
    getPendingTransaction,
    deletePendingTransaction,
    updatePendingTransaction,
    updatePendingTransactionStatus,
    updateTransactionMessageId,
    updateGlobalStats,
    upsertUserStats,
    addContribution,
    getPaymentRequest,
    getContributions
} from './db'

// Handle form responses (button clicks on Confirm/Cancel)
export async function handleFormResponse(
    handler: BotHandler,
    event: any,
    getEthPrice: () => Promise<number>,
    bot: any // Bot instance for getting bot address
) {
    const form = event.response.payload.content.value

    console.log('[Form Response] ========================')
    console.log('[Form Response] Request ID:', form.requestId)
    console.log('[Form Response] Event structure:', {
        eventId: event.eventId,
        userId: event.userId,
        channelId: event.channelId
    })

    // Get pending transaction from database
    const pendingTx = await getPendingTransaction(form.requestId)
    
    if (!pendingTx) {
        console.error('[Form Response] No pending transaction found for:', form.requestId)
        return
    }

    console.log('[Form Response] Found pending transaction:', {
        type: pendingTx.type,
        status: pendingTx.status,
        messageId: pendingTx.messageId
    })

    // Find which button was clicked
    const clickedButton = form.components.find((c: any) => c.component.case === 'button')
    console.log('[Form Response] Button clicked:', clickedButton?.id)

    if (!clickedButton) {
        console.error('[Form Response] No button found in form components')
        return
    }

    // Handle Cancel button
    if (clickedButton.id === 'cancel') {
        await deletePendingTransaction(form.requestId)
        await handler.sendMessage(event.channelId, '❌ Cancelled.')
        console.log('[Form Response] Transaction cancelled by user')

        // Delete the form after cancellation
        if (pendingTx.messageId) {
            try {
                await handler.removeEvent(event.channelId, pendingTx.messageId)
                console.log('[Form Response] ✅ Form deleted after cancellation, messageId:', pendingTx.messageId)
            } catch (error) {
                console.error('[Form Response] ❌ Failed to delete form after cancellation:', error)
            }
        }
        return
    }

    // Handle Confirm button
    if (clickedButton.id === 'confirm') {
        try {
            const data = pendingTx.data
            const ethPrice = await getEthPrice()

            // Handle different transaction types
            if (form.requestId.startsWith('contrib-')) {
                // Contribution
                const amountWei = parseEther(data.ethAmount.toString())
                const usdValue = data.contributionUsd.toFixed(2)

                const txMessage = await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}`,
                        title: `Send ~$${usdValue}`,
                        description: `Transfer ~$${usdValue} (${data.ethAmount.toFixed(6)} ETH) on Base\n\nTo: ${data.creatorWallet.slice(0, 6)}...${data.creatorWallet.slice(-4)}\n\n⚠️ Make sure you have enough ETH for the transfer plus gas (~$0.01)`,
                        content: {
                            case: 'evm',
                            value: {
                                chainId: '8453',
                                to: data.creatorWallet,
                                value: amountWei.toString(),
                                data: '0x',
                                signerWallet: undefined
                            }
                        }
                    }
                }, hexToBytes(event.userId as `0x${string}`))

                // Save transaction message ID for later deletion
                if (txMessage?.eventId) {
                    await updateTransactionMessageId(form.requestId, txMessage.eventId)
                    console.log('[Form Response] Saved transaction message ID:', txMessage.eventId)
                }

            } else if (form.requestId.startsWith('tip-')) {
                // Regular tip
                const amountWei = parseEther(data.ethAmount.toString())
                const usdValue = data.usdAmount.toFixed(2)

                const txMessage = await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}`,
                        title: `Send ~$${usdValue}`,
                        description: `Transfer ~$${usdValue} (${data.ethAmount.toFixed(6)} ETH) on Base\n\nTo: ${data.recipientWallet.slice(0, 6)}...${data.recipientWallet.slice(-4)}\n\n⚠️ Make sure you have enough ETH for the transfer plus gas (~$0.01)`,
                        content: {
                            case: 'evm',
                            value: {
                                chainId: '8453',
                                to: data.recipientWallet,
                                value: amountWei.toString(),
                                data: '0x',
                                signerWallet: undefined
                            }
                        }
                    }
                }, hexToBytes(event.userId as `0x${string}`))

                // Save transaction message ID for later deletion
                if (txMessage?.eventId) {
                    await updateTransactionMessageId(form.requestId, txMessage.eventId)
                    console.log('[Form Response] Saved transaction message ID:', txMessage.eventId)
                }

            } else if (form.requestId.startsWith('tipsplit-')) {
                // NEW: Tipsplit sends ONE transaction to BOT
                console.log('[Form Response] Processing tipsplit - sending to bot')
                
                const totalAmountWei = parseEther(data.totalEth.toString())
                const usdValue = data.totalUsd.toFixed(2)

                const txMessage = await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}`,
                        title: `Send ~$${usdValue} to TipsoBot`,
                        description: `Transfer ~$${usdValue} (${data.totalEth.toFixed(6)} ETH) to TipsoBot\n\nBot will split between ${data.recipients.length} recipients\n\n⚡ ONE signature, bot handles distribution!\n\n⚠️ Make sure you have enough ETH for the transfer plus gas (~$0.01)`,
                        content: {
                            case: 'evm',
                            value: {
                                chainId: '8453',
                                to: bot.appAddress, // Send to BOT!
                                value: totalAmountWei.toString(),
                                data: '0x',
                                signerWallet: undefined
                            }
                        }
                    }
                }, hexToBytes(event.userId as `0x${string}`))

                // Save transaction message ID
                if (txMessage?.eventId) {
                    await updateTransactionMessageId(form.requestId, txMessage.eventId)
                    console.log('[Form Response] Saved tipsplit transaction message ID:', txMessage.eventId)
                }

            } else if (form.requestId.startsWith('donate-')) {
                // Donation
                const amountWei = parseEther(data.ethAmount.toString())
                const usdValue = data.usdAmount.toFixed(2)

                const txMessage = await handler.sendInteractionRequest(event.channelId, {
                    case: 'transaction',
                    value: {
                        id: `tx-${form.requestId}`,
                        title: `Send ~$${usdValue}`,
                        description: `Donate ~$${usdValue} (${data.ethAmount.toFixed(6)} ETH) to TipsoBot\n\nYour support is appreciated! 🙏\n\n⚠️ Make sure you have enough ETH for the transfer plus gas (~$0.01)`,
                        content: {
                            case: 'evm',
                            value: {
                                chainId: '8453',
                                to: data.botAddress,
                                value: amountWei.toString(),
                                data: '0x',
                                signerWallet: undefined
                            }
                        }
                    }
                }, hexToBytes(event.userId as `0x${string}`))

                // Save transaction message ID for later deletion
                if (txMessage?.eventId) {
                    await updateTransactionMessageId(form.requestId, txMessage.eventId)
                    console.log('[Form Response] Saved transaction message ID:', txMessage.eventId)
                }
            }

            console.log('[Form Response] Transaction request sent successfully')

            // 🔑 Delete the form AFTER transaction request is sent
            // This prevents blocking if removeEvent times out
            if (pendingTx.messageId) {
                try {
                    await handler.removeEvent(event.channelId, pendingTx.messageId)
                    console.log('[Form Response] ✅ Form deleted successfully, messageId:', pendingTx.messageId)
                } catch (error) {
                    console.error('[Form Response] ❌ Failed to delete form:', error)
                    // Continue - form deletion failure is not critical
                }
            } else {
                console.log('[Form Response] ⚠️ No messageId found, cannot delete form')
            }

        } catch (error) {
            console.error('[Form Response] Error processing confirmation:', error)
            await handler.sendMessage(event.channelId, '❌ Failed to send transaction request. Please try again.')
        }
    }
}

// Handle transaction responses (actual blockchain transactions)
export async function handleTransactionResponse(
    handler: BotHandler,
    event: any,
    getEthPrice: () => Promise<number>,
    bot: any // Bot instance for executing batch
) {
    const transaction = event.response.payload.content.value
    const txId = transaction.requestId

    // Try multiple fields for transaction hash
    const txHash = transaction.hash || transaction.txHash || transaction.transactionHash || transaction.receipt?.hash || transaction.receipt?.transactionHash
    const spaceId = event.spaceId

    console.log('[Transaction Response] ========================')
    console.log('[Transaction Response] Received transaction result for:', txId)
    console.log('[Transaction Response] Transaction hash:', txHash)
    console.log('[Transaction Response] SpaceId:', spaceId)
    console.log('[Transaction Response] EventId:', event.eventId)
    console.log('[Transaction Response] UserId:', event.userId)
    console.log('[Transaction Response] ChannelId:', event.channelId)
    console.log('[Transaction Response] Available transaction keys:', Object.keys(transaction))
    console.log('[Transaction Response] ========================')

    try {
        // Extract the original request ID from transaction ID
        // Format: tx-{type}-{eventId}
        const parts = txId.split('-')
        let originalRequestId: string

        if (parts[0] === 'tx' && parts.length >= 3) {
            // Format: tx-tip-eventId, tx-donate-eventId, tx-contrib-eventId, tx-tipsplit-eventId
            originalRequestId = `${parts[1]}-${parts[2]}`
        } else {
            console.error('[Transaction Response] Invalid transaction ID format:', txId)
            return
        }

        console.log('[Transaction Response] Original request ID:', originalRequestId)
        console.log('[Transaction Response] Looking up in DB...')

        // Check if transaction was already processed
        const pendingTx = await getPendingTransaction(originalRequestId)
        
        console.log('[Transaction Response] DB lookup result:', {
            found: !!pendingTx,
            status: pendingTx?.status,
            type: pendingTx?.type
        })

        if (!pendingTx) {
            console.log('[Transaction Response] 🛑 No transaction record found at all')
            return
        }

        // 🔑 KEY FIX: Check if already processed (not just pending)
        if (pendingTx.status === 'processed') {
            console.log('[Transaction Response] 🛑 DUPLICATE! Transaction already processed:', originalRequestId)
            console.log('[Transaction Response] Ignoring this duplicate callback')
            return
        }

        if (pendingTx.status === 'pending') {
            console.log('[Transaction Response] ✅ Status is "pending", proceeding with processing...')
        } else {
            console.log('[Transaction Response] Status is:', pendingTx.status)
            return
        }

        // Handle contribution (stored in database)
        if (originalRequestId.startsWith('contrib-')) {
            console.log('[Transaction Response] Processing contribution...')
            const data = pendingTx.data
            const ethPrice = await getEthPrice()

            // Add contribution to database
            const updatedRequest = await addContribution({
                requestId: data.requestId,
                contributorId: data.contributorId,
                contributorName: 'Contributor',
                amount: data.contributionUsd
            })

            // Check if this contribution just completed the request
            const now = new Date()
            const completedAt = updatedRequest.completed_at ? new Date(updatedRequest.completed_at) : null
            const justCompleted = updatedRequest.is_completed &&
                                  completedAt &&
                                  (now.getTime() - completedAt.getTime() < 10000) // Within 10 seconds

            // Update global stats (per space/town)
            await updateGlobalStats(spaceId, {
                crowdfundingVolume: data.contributionUsd,
                crowdfundingCount: justCompleted ? 1 : 0
            })

            // Update user stats (per space/town)
            await upsertUserStats(spaceId, data.contributorId, data.contributorId, {
                sentAmount: data.contributionUsd,
                tipsSent: 1,
                tipsSentAmount: data.contributionUsd
            })
            await upsertUserStats(spaceId, data.creatorId, data.creatorName, {
                receivedAmount: data.contributionUsd,
                tipsReceived: 1,
                tipsReceivedAmount: data.contributionUsd
            })

            // Send success message with transaction hash
            const txHashInfo = txHash ? `\n\n🔗 [View on BaseScan](https://basescan.org/tx/${txHash})` : ''
            await handler.sendMessage(
                data.channelId,
                `✅ <@${data.contributorId}> contributed ~$${data.contributionUsd.toFixed(2)} to <@${data.creatorId}>!${txHashInfo}`,
                { mentions: [
                    { userId: data.contributorId, displayName: data.contributorId },
                    { userId: data.creatorId, displayName: data.creatorName }
                ] }
            )

            // Get updated payment request
            const paymentRequest = await getPaymentRequest(data.requestId)
            if (paymentRequest) {
                const contributions = await getContributions(data.requestId)
                const progress = (parseFloat(paymentRequest.total_collected) / parseFloat(paymentRequest.amount)) * 100
                const progressBar = progress >= 100
                    ? '▰'.repeat(10)
                    : '▰'.repeat(Math.floor(progress / 10)) + '▱'.repeat(10 - Math.floor(progress / 10))

                // Post update message
                const updateMessage = progress >= 100
                    ? `**💰 Payment Request COMPLETED! 🎉**\n\n` +
                        `**Goal:** $${parseFloat(paymentRequest.amount).toFixed(2)}\n` +
                        `**Description:** ${paymentRequest.description}\n` +
                        `**Collected:** $${parseFloat(paymentRequest.total_collected).toFixed(2)} / $${parseFloat(paymentRequest.amount).toFixed(2)}\n` +
                        `**Progress:** ${progressBar} ${progress.toFixed(0)}%${progress > 100 ? ' 🚀 **Goal exceeded!**' : ''}\n` +
                        `**Contributors:** ${contributions.length}\n\n` +
                        `🎉 **Goal reached! Thank you to all contributors!** 🎉`
                    : `**💰 Payment Request Updated**\n\n` +
                        `**Goal:** $${parseFloat(paymentRequest.amount).toFixed(2)}\n` +
                        `**Description:** ${paymentRequest.description}\n` +
                        `**Collected:** $${parseFloat(paymentRequest.total_collected).toFixed(2)} / $${parseFloat(paymentRequest.amount).toFixed(2)}\n` +
                        `**Progress:** ${progressBar} ${progress.toFixed(0)}%\n` +
                        `**Contributors:** ${contributions.length}\n\n` +
                        `To contribute: \`/contribute ${data.requestId} amount\``

                await handler.sendMessage(paymentRequest.channel_id, updateMessage)
            }

            // 🔑 KEY FIX: Mark as processed but DON'T delete (keep for 7 days for duplicate detection)
            console.log('[Transaction Response] Marking as processed (keeping in DB for 7 days)')
            await updatePendingTransactionStatus(originalRequestId, 'processed')

            // Delete transaction confirmation form
            console.log('[Transaction Response] pendingTx.transactionMessageId:', pendingTx.transactionMessageId)
            if (pendingTx.transactionMessageId) {
                try {
                    await handler.removeEvent(data.channelId, pendingTx.transactionMessageId)
                    console.log('[Transaction Response] ✅ Transaction form deleted successfully')
                } catch (error) {
                    console.error('[Transaction Response] ❌ Failed to delete transaction form:', error)
                }
            } else {
                console.log('[Transaction Response] ⚠️ No transaction_message_id found, cannot delete transaction form')
            }

            console.log('[Transaction Response] ✅ Contribution successfully processed!')

        } else if (originalRequestId.startsWith('tip-')) {
            // Regular tip
            console.log('[Transaction Response] Processing regular tip...')
            const data = pendingTx.data

            // Update global stats (per space/town)
            await updateGlobalStats(spaceId, {
                tipsVolume: data.usdAmount,
                tipsCount: 1
            })

            // Update user stats (per space/town)
            await upsertUserStats(spaceId, pendingTx.userId, pendingTx.userId, {
                sentAmount: data.usdAmount,
                tipsSent: 1,
                tipsSentAmount: data.usdAmount
            })

            // Update recipient stats - handle both mention and direct address
            if (data.recipientId) {
                await upsertUserStats(spaceId, data.recipientId, data.recipientName || 'User', {
                    receivedAmount: data.usdAmount,
                    tipsReceived: 1,
                    tipsReceivedAmount: data.usdAmount
                })
            }

            // Send success message with transaction hash
            const recipientDisplay = data.recipientId 
                ? `<@${data.recipientId}>`
                : `${data.recipientWallet.slice(0, 6)}...${data.recipientWallet.slice(-4)}`

            const mentions = data.recipientId
                ? [
                    { userId: pendingTx.userId, displayName: pendingTx.userId },
                    { userId: data.recipientId, displayName: data.recipientName || 'User' }
                  ]
                : [{ userId: pendingTx.userId, displayName: pendingTx.userId }]

            const txHashInfo = txHash ? `\n\n🔗 [View on BaseScan](https://basescan.org/tx/${txHash})` : ''
            await handler.sendMessage(
                data.channelId,
                `💸 <@${pendingTx.userId}> sent ~$${data.usdAmount.toFixed(2)} (${data.ethAmount.toFixed(6)} ETH) to ${recipientDisplay}!${txHashInfo}`,
                { mentions }
            )

            // 🔑 KEY FIX: Mark as processed but DON'T delete
            console.log('[Transaction Response] Marking as processed (keeping in DB for 7 days)')
            await updatePendingTransactionStatus(originalRequestId, 'processed')

            // Delete transaction confirmation form
            console.log('[Transaction Response] pendingTx.transactionMessageId:', pendingTx.transactionMessageId)
            if (pendingTx.transactionMessageId) {
                try {
                    await handler.removeEvent(data.channelId, pendingTx.transactionMessageId)
                    console.log('[Transaction Response] ✅ Transaction form deleted successfully')
                } catch (error) {
                    console.error('[Transaction Response] ❌ Failed to delete transaction form:', error)
                }
            } else {
                console.log('[Transaction Response] ⚠️ No transaction_message_id found, cannot delete transaction form')
            }

            console.log('[Transaction Response] ✅ Tip successfully processed!')

        } else if (originalRequestId.startsWith('tipsplit-')) {
  console.log('[Transaction Response] Processing tipsplit...')
  const data = pendingTx.data
  
  // Check txHash exists
  if (!txHash) {
    console.error('[Transaction Response] No txHash for tipsplit!')
    await handler.sendMessage(data.channelId, `❌ No transaction hash found.`)
    await updatePendingTransactionStatus(originalRequestId, 'failed')
    return
  }
  
  // CRITICAL: Wait for user's deposit transaction to be confirmed on blockchain
  console.log('[Transaction Response] Waiting for deposit tx confirmation...', txHash)
  const receipt = await waitForTransactionReceipt(bot.viem, { 
    hash: txHash as `0x${string}` 
  })
  
  // Check if transaction succeeded
  if (receipt.status !== 'success') {
    console.error('[Transaction Response] Deposit transaction failed!')
    await handler.sendMessage(
      data.channelId,
      `❌ Deposit transaction failed. Money never left your wallet.`
    )
    await updatePendingTransactionStatus(originalRequestId, 'failed')
    return
  }
  
  console.log('[Transaction Response] ✅ Deposit confirmed! Now executing batch...')
  
  try {

                // Build batch calls for execute()
                const calls = data.recipients.map((r: any) => ({
                    to: r.wallet as `0x${string}`,
                    value: parseEther(r.ethAmount.toString()),
                    data: '0x' as `0x${string}`
                }))

                console.log('[Transaction Response] Executing batch transfer...', {
                    recipientCount: calls.length,
                    totalEth: data.totalEth
                })

                // Execute batch transfer from bot
                const hash = await execute(bot.viem, {
                    address: bot.appAddress as `0x${string}`,
                    account: bot.viem.account,
                    calls
                })

                console.log('[Transaction Response] Batch transaction sent:', hash)

                // Wait for confirmation
                await waitForTransactionReceipt(bot.viem, { hash })

                console.log('[Transaction Response] Batch transaction confirmed!')

                // Update global stats
                await updateGlobalStats(spaceId, {
                    tipsVolume: data.totalUsd,
                    tipsCount: 1
                })

                // Update sender stats
                await upsertUserStats(spaceId, pendingTx.userId, pendingTx.userId, {
                    sentAmount: data.totalUsd,
                    tipsSent: 1,
                    tipsSentAmount: data.totalUsd
                })

                // Update each recipient's stats
                for (const recipient of data.recipients) {
                    if (recipient.userId) {
                        await upsertUserStats(
                            spaceId,
                            recipient.userId,
                            recipient.displayName || 'User',
                            {
                                receivedAmount: recipient.usdAmount,
                                tipsReceived: 1,
                                tipsReceivedAmount: recipient.usdAmount
                            }
                        )
                    }
                }

                // Send success message
                const recipientList = data.recipients
                    .map((r: any) => r.userId ? `<@${r.userId}>` : `${r.wallet.slice(0, 6)}...${r.wallet.slice(-4)}`)
                    .join(', ')

                const mentions = data.recipients
                    .filter((r: any) => r.userId)
                    .map((r: any) => ({ userId: r.userId, displayName: r.displayName || 'User' }))

                mentions.push({ userId: pendingTx.userId, displayName: 'Sender' })

                await handler.sendMessage(
                    data.channelId,
                    `💸 <@${pendingTx.userId}> sent ~$${data.totalUsd.toFixed(2)} (${data.totalEth.toFixed(6)} ETH) split between ${recipientList} in ONE transaction! ⚡\n\n🔗 [Deposit TX](https://basescan.org/tx/${txHash})\n🔗 [Batch TX](https://basescan.org/tx/${hash})`,
                    { mentions }
                )

                // Mark as processed
                await updatePendingTransactionStatus(originalRequestId, 'processed')

                // Delete transaction form
                if (pendingTx.transactionMessageId) {
                    try {
                        await handler.removeEvent(data.channelId, pendingTx.transactionMessageId)
                        console.log('[Transaction Response] ✅ Transaction form deleted')
                    } catch (error) {
                        console.error('[Transaction Response] ❌ Failed to delete form:', error)
                    }
                }

                console.log('[Transaction Response] ✅ Tipsplit successfully processed!')

            } catch (error) {
                console.error('[Transaction Response] 🔥 Batch execution failed:', error)
                
                // Refund to sender
                try {
                    console.log('[Transaction Response] Attempting refund to sender...')
                    const refundAmount = parseEther(data.totalEth.toString())
                    const senderWallet = await bot.viem.account.address

                    const refundHash = await bot.viem.sendTransaction({
                        to: pendingTx.userId as `0x${string}`,
                        value: refundAmount,
                        account: bot.viem.account
                    })

                    await waitForTransactionReceipt(bot.viem, { hash: refundHash })

                    await handler.sendMessage(
                        data.channelId,
                        `❌ Tipsplit failed! Funds refunded to <@${pendingTx.userId}>.\n\n🔗 [Refund TX](https://basescan.org/tx/${refundHash})`,
                        { mentions: [{ userId: pendingTx.userId, displayName: 'User' }] }
                    )

                    console.log('[Transaction Response] ✅ Refund successful')
                } catch (refundError) {
                    console.error('[Transaction Response] 🔥 Refund also failed:', refundError)
                    await handler.sendMessage(
                        data.channelId,
                        `⚠️ Tipsplit failed and refund failed! Please contact support. Your funds are safe in bot wallet.`
                    )
                }

                // Mark as failed
                await updatePendingTransactionStatus(originalRequestId, 'failed')
            }

        } else if (originalRequestId.startsWith('donate-')) {
            // Donation
            console.log('[Transaction Response] Processing donation...')
            const data = pendingTx.data

            // Update global stats (per space/town)
            await updateGlobalStats(spaceId, {
                donationsVolume: data.usdAmount,
                donationsCount: 1
            })

            // Update user stats (per space/town)
            await upsertUserStats(spaceId, pendingTx.userId, pendingTx.userId, {
                donations: 1,
                donationsSentAmount: data.usdAmount
            })

            // Send success message with transaction hash
            const txHashInfo = txHash ? `\n\n🔗 [View on BaseScan](https://basescan.org/tx/${txHash})` : ''
            await handler.sendMessage(
                data.channelId,
                `❤️ Thank you <@${pendingTx.userId}> for your ~$${data.usdAmount.toFixed(2)} (${data.ethAmount.toFixed(6)} ETH) donation! Your support means everything! 🙏${txHashInfo}`,
                { mentions: [{ userId: pendingTx.userId, displayName: pendingTx.userId }] }
            )

            // 🔑 KEY FIX: Mark as processed but DON'T delete (keep for 7 days)
            console.log('[Transaction Response] Marking donation as processed (keeping in DB for 7 days)')
            await updatePendingTransactionStatus(originalRequestId, 'processed')

            // Delete transaction confirmation form
            console.log('[Transaction Response] pendingTx.transactionMessageId:', pendingTx.transactionMessageId)
            if (pendingTx.transactionMessageId) {
                try {
                    await handler.removeEvent(data.channelId, pendingTx.transactionMessageId)
                    console.log('[Transaction Response] ✅ Transaction form deleted successfully')
                } catch (error) {
                    console.error('[Transaction Response] ❌ Failed to delete transaction form:', error)
                }
            } else {
                console.log('[Transaction Response] ⚠️ No transaction_message_id found, cannot delete transaction form')
            }

            console.log('[Transaction Response] ✅ Donation successfully processed!')

        } else {
            console.log('[Transaction Response] Unknown transaction type:', originalRequestId)
        }

    } catch (error) {
        console.error('[Transaction Response] 🔥 CRITICAL ERROR:', error)
    }
}
