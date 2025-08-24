AutoPoster Telegram Bot
Overview
AutoPoster is a Telegram bot designed to automate posting to Telegram channels. It supports scheduled posts, subscription-based access with different tiers (Standard, VIP, Ultra), and VPN configuration distribution for Ultra-tier users. The bot integrates with MongoDB for data storage and uses Telegram Stars for payments.
Features

Scheduled Posting: Users can schedule posts with customizable intervals and content (text or media).
Subscription Tiers:
Standard: Minimum post interval of 300 seconds, up to 1 scheduled post.
VIP: Minimum post interval of 90 seconds, up to 3 scheduled posts.
Ultra: Minimum post interval of 30 seconds, up to 5 scheduled posts, and VPN support.
Trial: 14-day trial period with Standard tier benefits; reverts to restricted mode upon expiration.


VPN Support: Ultra-tier users and admins can configure a VPN channel to receive periodic VPN configuration updates.
Admin Panel: Admins can manage VPN configurations, ban/unban users, set custom ban messages, and issue promotional subscriptions.
Anti-Spam Protection: Implements cooldowns to prevent abuse.
MongoDB Integration: Stores user data, schedules, settings, and transactions.
Payment System: Supports Telegram Stars for subscription purchases.

Prerequisites

Node.js (v16 or higher)
MongoDB (local or cloud-hosted, e.g., MongoDB Atlas)
Telegram Bot Token (obtained via BotFather)
Telegram Payment Provider Token (for Telegram Stars)
A cover photo (media/cover.jpg) for the bot’s main menu

Installation

Clone the Repository:
git clone <repository-url>
cd autoposter-bot


Install Dependencies:
npm install


Set Up Environment Variables:Create a .env file in the root directory with the following:
BOT_TOKEN=your-telegram-bot-token
PROVIDER_TOKEN=your-telegram-payment-provider-token
MONGO_URI=your-mongodb-connection-string


Ensure Cover Photo:Place a cover.jpg file in the media directory relative to the project root.

Run the Bot:
node index.js



Usage

Start the Bot:

Interact with the bot on Telegram by sending /start.
The bot will display a main menu with options based on the user’s subscription tier.


Key Commands:

Profil 👤: View user profile, subscription status, and transaction history.
Dükan 🛒: Access the shop to purchase VIP or Ultra subscriptions.
Maslahat goş 💫: Schedule a new post for a Telegram channel.
Maslahatlary gör 📋: View and manage existing schedules.
VPNlary gör 📋: View VPN channels (Ultra-tier or admin only).
VPN goş 🌐: Add a VPN channel (Ultra-tier or admin only).
Panel 🎛️: Access admin panel (admin only).


Admin Commands:

Available via the admin panel for the designated admin (set via ADMIN_ID).
Includes managing VPN configurations, banning/unbanning users, setting ban messages, and issuing promotional subscriptions.


Scheduling Posts:

Users must be channel owners and add the bot as an administrator with post and delete permissions.
Specify channel ID, message text, and posting interval (subject to subscription tier limits).


VPN Configuration:

Ultra-tier users can set a channel to receive VPN configurations.
Admins can update the global VPN configuration, which is sent to all Ultra-tier users’ VPN channels weekly.



Configuration

MongoDB: Uses collections for schedules, users, settings, and transactions.
Subscription Limits:
Configurable via the SUBSCRIPTIONS object in the code.
Default trial period: 14 days.


Anti-Spam: 1-second cooldown between user actions (ANTISPAM_COOLDOWN).
VPN Updates: Sent every 7 days to Ultra-tier users’ channels if configured.

Notes

The bot uses the Turkmen language for user interactions.
Payments are non-refundable and processed via Telegram Stars.
Ensure the bot has appropriate permissions in channels for posting and deleting messages.
The bot requires a stable MongoDB connection to function correctly.
Error handling includes retry logic for Telegram API rate limits (HTTP 429).

Troubleshooting

MongoDB Connection Issues: Verify MONGO_URI and network access to MongoDB.
Bot Not Responding: Check BOT_TOKEN and ensure the bot is not banned in Telegram.
Payment Issues: Validate PROVIDER_TOKEN with Telegram’s payment provider.
Channel Posting Errors: Ensure the bot is an admin in the target channel with required permissions.

License
This project is provided by MIT license.
