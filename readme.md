# PicChatter

A small Express + EJS web app for talking about a picture. You upload an image, speak a question, and the app answers aloud.

## How it works

1. **Upload**: the browser posts the image to `POST /upload` (max 5 MB, enforced by multer). The server streams it to a DigitalOcean Spaces bucket (S3 API, `public-read`) using the original file name as the object key, then deletes the temp file.
2. **Speech in**: the browser listens with [annyang](https://github.com/TalAter/annyang) (Web Speech API, so Chrome or Edge).
3. **Answer**: for a text-only message the page picks a canned reply. Once an image is uploaded, the page calls your own describe service at `API_ENDPOINT + <image file name> + "/" + <question>` (both URL-encoded) and expects JSON with a `description` field. That service is not part of this repo.
4. **Speech out**: replies are read aloud through `GET /speech/:text`, which streams MP3 from `node-gtts` (Google Translate TTS, needs internet). While a reply is playing the microphone is muted so the app does not hear itself, and it is turned back on afterwards if it was on before. Space pauses and resumes playback (pausing also turns the mic back on).

## Setup

```bash
npm install
```

Create `.env`:

```env
PORT=3000
API_ENDPOINT=https://your-describe-service.example.com/describe/   # must end with a slash
SPACES_ENDPOINT=nyc3.digitaloceanspaces.com
SPACES_KEY=your_spaces_access_key
SPACES_SECRET=your_spaces_secret
SPACES_BUCKET=your_bucket
```

`API_ENDPOINT` falls back to a placeholder URL if unset. Uploads fail with HTTP 500 if the `SPACES_*` variables are missing.

```bash
npm start
```

Open http://localhost:3000. `GET /health` returns `OK`.

## Notes

- Uploaded files are keyed by their original file name, so two files with the same name overwrite each other in the bucket.
- `/uploads` is served statically, but nothing in the app writes there; multer uses a temporary `PicChatter/` folder.

## License

ISC
