import type { BotCommand } from '@towns-protocol/bot'

// Those commands will be registered to the bot as soon as the bot is initialized
// and will be available in the slash command autocomplete.
const commands = [
    {
        name: 'help',
        description: 'Get help with bot commands',
    },
    {
        name: 'time',
        description: 'Get the current time',
    },
    {
        name: 'tip',
        description: 'Tip a user in USD (auto-converted to ETH)',
    },
    {
        name: 'tipsplit',
        description: 'Split USD tip between multiple users',
    },
    {
        name: 'donate',
        description: 'Donate in USD to support the bot',
    },
    {
        name: 'stats',
        description: 'View your tipping statistics',
    },
    {
        name: 'leaderboard',
        description: 'View top tippers and donators',
    },
    {
        name: 'request',
        description: 'Create a payment request for others to contribute',
    },
    {
        name: 'contribute',
        description: 'Contribute to a payment request',
    },
] as const satisfies BotCommand[]

export default commands
