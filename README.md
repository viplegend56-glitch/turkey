# Turkeycoin ($TURKEY) site

A Thanksgiving-Day charity site for a Solana community coin. Creator fees go to a line of 104 food charities, one every 15 minutes, and every donation gets a receipt on the site.

Live address: **https://turkeycoin.site**

## What's in this folder

| Path | What it is |
|---|---|
| `docs/` | The public site that GitHub Pages serves: `index.html`, `hope.config.json`, `CNAME` (turkeycoin.site) and `.nojekyll`. The counter job adds `impact.json` here. |
| `hope.config.json` | A copy of the settings. The admin panel keeps it and `docs/hope.config.json` the same. |
| `panel/` | The online admin panel. Deploy it on Vercel (below). |
| `.github/workflows/impact.yml` | The job that keeps the "raised so far" counter current, every 15 minutes. |
| `scripts/`, `api/`, `lib/` | Code the counter job uses, plus `refresh-lines.mjs` to re-check charities against donate.gg. |
| `admin.html`, `server.mjs` | The same editor, for use on your own computer: `node server.mjs`, then open `http://localhost:3000/admin.html`. Not published. |
| `test/` | Checks: `npm test` (Node 18+). |

There is nothing to install and no build step.

## 1. Put it on GitHub

1. On github.com: **+** (top right), **New repository**. Name it `turkeycoin`, make it **Public**, and don't add a README. **Create repository**.
2. On the empty repo page, click **uploading an existing file**. Drag in everything from this folder (the `docs`, `panel`, `scripts`, `api`, `lib`, `test`, `data` folders and the files), then **Commit changes**.
3. Check that the repo now has a `.github` folder. Folders whose names start with a dot are hidden on a Mac and sometimes don't get dragged along. If it's missing: **Add file**, **Create new file**, type the name `.github/workflows/impact.yml`, paste in the contents of that file from this folder, and commit.

## 2. Turn on the website (GitHub Pages)

1. In the repo: **Settings**, **Pages**. Under **Build and deployment**: Source **Deploy from a branch**, branch **main**, folder **/docs**. **Save**.
2. Under **Custom domain** it should say `turkeycoin.site` (the `CNAME` file fills it in). If it's empty, type it and save. Do this before changing DNS so nobody else can claim the domain.
3. At the company you bought turkeycoin.site from, open its DNS settings and add:
   - four **A** records for `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - one **CNAME** record for `www` pointing to `viplegend56-glitch.github.io`

   Delete any parking or forwarding records the registrar added. Don't add a `*` record.
4. Back in **Settings**, **Pages**: once the DNS check turns green (minutes to a few hours), tick **Enforce HTTPS**.

## 3. Turn on the admin panel (Vercel)

1. On GitHub: your profile picture, **Settings**, **Developer settings**, **Personal access tokens**, **Fine-grained tokens**, **Generate new token**. Name it "Turkeycoin admin panel". **Repository access**: Only select repositories, `turkeycoin`. **Permissions**, Repository permissions: **Contents**, Read and write. Generate, and copy the token.
2. On vercel.com: **Add New**, **Project**, import the `turkeycoin` repo.
3. Before deploying: **Root Directory**, **Edit**, choose `panel`. **Framework Preset**: Other. Leave the build settings empty.
4. **Environment Variables**: `ADMIN_PASSWORD` (a long one, 16+ characters) and `GITHUB_TOKEN` (the token). Type these into Vercel only, never into a file or a chat.
5. **Deploy**, open the `….vercel.app` address and sign in. If a setting is missing, the page says which one.

Changes you make in the panel are saved to the repo straight away and show on the site within a couple of minutes. The panel only redeploys when something in `panel/` changes, so saving settings doesn't trigger a build.

When the token expires, saving stops with "GitHub did not accept the token". Make a new one, replace `GITHUB_TOKEN` in Vercel, and redeploy (Deployments, the latest one, Redeploy).

## 4. The counter

`.github/workflows/impact.yml` runs every 15 minutes (GitHub sometimes runs it late) and writes `docs/impact.json`. To run it right away: **Actions** tab, **Update donation counter**, **Run workflow**.

- Until the contract address is set, the counter shows $0 and "Starts at launch".
- "Raised so far" is every creator fee the coin has earned on pump.fun, claimed or not, in dollars at the current SOL price. Launch from a wallet that has launched no other coin, or those fees get counted too.
- "Given so far" comes from the receipts you add in the admin (Proof).
- Optional: a Solana RPC URL from a provider such as Helius as a repository secret named `HOPE_RPC_URL` (Settings, Secrets and variables, Actions). Without it the job uses a public endpoint, slowly. Add one if runs start failing.
- Don't upload a `docs/impact.json` of your own: the job owns that file.

## At launch

1. In the admin, **Links**: paste the contract address and the X link.
2. **Rotation**: press **Start over**, so the line starts from Feeding America Tampa Bay at launch instead of where the clock has it now.
3. Pause, Resume and Skip are on the same page if you need them during the day.

## Running locally

```
node server.mjs
```

Site at `http://localhost:3000`, editor at `http://localhost:3000/admin.html`. The editor can export a `hope.config.json`; if the panel is ever down, replace both copies in the repo with it.
