# BPS Donations

Live donation status page for Bellingham Pickup Soccer. It reads directly from the Google Sheet that the Apps Script fills:

- **Balance:** `Summary!B4`
- **Progress:** progress toward the $250 needed for the next Wednesday rental
- **Recent donations:** the 7 latest Venmo, Zelle or Cash payments with Direction = Received from `Transactions`

## Requirements
The sheet must be shared as **Anyone with the link → Viewer**.

## Run locally
```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages
1. Create a GitHub repo and push these files to `main`.
2. Go to repo **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then pick `main` and `/ (root)`.
3. The site goes live at `https://<user>.github.io/<repo>/`.

Configuration (sheet ID, goal amount, rental day/time) is at the top of `app.js`.
