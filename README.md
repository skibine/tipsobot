# TipsoBot 💸

A Towns Protocol bot for sending tips in USD (auto-converted to ETH on Base).

## Features

- 💸 **Tipping**: Send money to users in USD (auto-converted to ETH)
- 🎯 **Tip Split**: Split tips between multiple users
- ❤️ **Donations**: Support the bot
- 💰 **Crowdfunding**: Create payment requests and collect contributions
- 📊 **Statistics**: Global bot statistics across all channels
- 🏆 **Leaderboard**: Top tippers and donators

## Setup

### Requirements

- Node.js 18+
- PostgreSQL 14+
- Towns Protocol bot credentials

### Installation

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file:
```bash
cp .env.example .env
```

3. Configure environment variables in `.env`:
```
APP_PRIVATE_DATA=your_bot_private_data_here
JWT_SECRET=your_jwt_secret_here
DATABASE_URL=postgresql://username:password@localhost:5432/tipsobot
DATABASE_SSL=false
```

### Database Setup

1. Create PostgreSQL database:
```bash
createdb tipsobot
```

2. The bot will automatically initialize the database schema on first run.

Alternatively, you can manually run the schema:
```bash
psql tipsobot < src/schema.sql
```

### Running

Development:
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```

## Commands

- `/tip @user amount` - Send money to a user
- `/tipsplit @user1 @user2 amount` - Split equally between users
- `/donate amount` - Support the bot
- `/request amount description` - Create payment request (24h cooldown)
- `/contribute requestId amount` - Contribute to a request
- `/stats` - View global bot statistics
- `/leaderboard` - View top tippers & donators
- `/help` - Show help message
- `/time` - Current server time

## Architecture

### Database

- **PostgreSQL** for persistent storage
- **Global stats** tracking across all channels
- **User stats** for individual statistics
- **Payment requests** for crowdfunding
- **Contributions** tracking
- **User cooldowns** for rate limiting
- **Pending transactions** for delayed confirmation

### Key Features

1. **Stateless Transaction Handling**:
   - Contributions are saved to database but NOT finalized until blockchain transaction is confirmed
   - Fixes race condition where stats were updated before user could cancel

2. **24-Hour Cooldown**:
   - Users can only create one `/request` every 24 hours
   - Prevents spam

3. **USD to ETH Conversion**:
   - Automatic conversion using CoinGecko API
   - 5-minute price cache with fallback

4. **Balance Checking**:
   - Checks user balance before allowing transactions

## Code Structure

- `src/index.ts` - Main bot logic and command handlers
- `src/commands.ts` - Slash command definitions
- `src/db.ts` - PostgreSQL database functions
- `src/handlers.ts` - Interaction response handlers
- `src/schema.sql` - Database schema

## License

MIT
