# Deploying PokéProfit API to Render

No credit card required. Takes about 5 minutes.

---

## Step 1 — Push to GitHub

1. Create a free account at **github.com** if you don't have one
2. Create a new repository (call it `pokeprofit-server`, set it to Public)
3. Upload the contents of this folder to that repository
   - Easiest way: drag and drop all files onto the GitHub repo page

---

## Step 2 — Deploy on Render

1. Create a free account at **render.com**
2. Click **New → Web Service**
3. Connect your GitHub account and select the `pokeprofit-server` repo
4. Render will auto-detect the `render.yaml` file — all settings are pre-filled
5. Click **Deploy Web Service**
6. Wait ~2 minutes for the build to complete
7. Copy your live URL — it will look like:
   ```
   https://pokeprofit-server.onrender.com
   ```

---

## Step 3 — Wire the calculator to your live URL

Open `pokemon-calc.html` in a text editor and find this line near the bottom:

```js
const DEPLOYED_API = '';
```

Replace it with your Render URL:

```js
const DEPLOYED_API = 'https://pokeprofit-server.onrender.com';
```

Save the file. Live prices will now fetch from your cloud server — no local
server, no CORS issues, no 403 errors.

---

## Free tier note

Render's free tier spins the server down after 15 minutes of inactivity.
The first fetch after a period of idle takes ~30 seconds to wake up — the
calculator already has a 30-second timeout to handle this gracefully.

To keep the server always-on, upgrade to Render's **Starter plan ($7/month)**.

---

## Locking down access (optional)

If you want only your own site to be able to call the API, set the
`ALLOWED_ORIGINS` environment variable in Render's dashboard:

```
ALLOWED_ORIGINS = https://yoursite.com
```

Leave it as `*` to allow any origin (fine for personal use).
