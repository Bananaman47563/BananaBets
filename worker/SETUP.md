# Setting up the Kalshi proxy (free Cloudflare Worker)

This takes about 10 minutes. You only do it once.

## 1. Create a free Cloudflare account
1. Go to https://dash.cloudflare.com/sign-up and sign up with your email.
2. Confirm your email. You don't need to add a domain or a payment method.

## 2. Create the Worker
1. In the Cloudflare dashboard, open **Workers & Pages** in the left menu.
2. Click **Create**, then **Create Worker**.
3. Name it `bananabets-kalshi` and click **Deploy**. (Keep the default code for now.)
4. Click **Edit code**.
5. Delete everything in the editor.
6. Open `worker/kalshi-proxy.js` in this folder, copy all of it, and paste it into the editor.
7. Click **Deploy**.

## 3. Copy your Worker's address
After deploying, the Worker page shows an address like:

    https://bananabets-kalshi.YOUR-NAME.workers.dev

## 4. Test it
Open this in your browser, replacing the address with yours:

    https://bananabets-kalshi.YOUR-NAME.workers.dev/markets?league=nfl

You should see text starting with `{"league":"nfl"...` containing NFL markets. If you see an error, tell me the text it shows.

## 5. Paste the address into BananaBets
Open BananaBets → **Settings** → paste the address into **Kalshi proxy address** and click Save.
