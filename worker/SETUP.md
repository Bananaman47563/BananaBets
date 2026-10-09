# Setting up the Kalshi proxy (free Cloudflare Worker)

This takes about 10 minutes. You only do it once. Kalshi blocks requests that come from websites, so this small
Worker fetches Kalshi's public prices on Cloudflare's servers and passes them to BananaBets. It is read-only: it
never places orders and never holds a key or account.

## 1. Create a free Cloudflare account
1. Go to https://dash.cloudflare.com/sign-up and sign up with your email and a password.
2. Confirm your email. You don't need to add a domain or a payment method.

## 2. Create the Worker
1. In the Cloudflare dashboard, click **Workers & Pages** in the left menu.
2. Click **Create**, then **Create Worker**.
3. Name it `bananabets-kalshi` and click **Deploy**. (Keep the placeholder code for now.)
4. On the Worker's page, click **Edit code**.
5. Select everything in the editor and delete it.
6. In your `bananabets` folder, open `worker/kalshi-proxy.js`, select all, copy, and paste it into the editor.
7. Click **Deploy**.

If you set this up before, repeat steps 4 to 7 with the new code. Nothing else changes.

## 3. Copy your Worker's address
The Worker's page shows an address like:

    https://bananabets-kalshi.YOUR-NAME.workers.dev

## 4. Test it in your browser
Add `/markets?league=nfl` to the end of your address:

    https://bananabets-kalshi.YOUR-NAME.workers.dev/markets?league=nfl

You should see text starting with `{"league":"nfl"` and a list of markets. If you see an error, copy the text and send it to me.

## 5. Paste the address into BananaBets
Open BananaBets → **Settings** → paste the address into **Kalshi proxy address** and leave the box (it saves automatically).
Then open **Markets**.

## Troubleshooting
- **"Kalshi responded with 403" or "could not be reached"**: Kalshi may be refusing Cloudflare's servers. Tell me the exact message.
- **Markets shows "Kalshi prices aren't connected yet"**: the address in Settings is empty or wrong. Check for a typo and no trailing spaces.
- **A trend chart says "Trend unavailable"**: the history route failed. Check that `/history?ticker=KXNFLGAME-26OCT19WASSF-WAS&days=7` works in your browser (any open ticker will do).
