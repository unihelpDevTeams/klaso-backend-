# Klaso backend

## Configure Cloudflare R2

1. Create an R2 bucket and an R2 API token with object read/write permissions.
2. Copy `.env.example` to `.env` and set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME`.
3. Set `R2_PUBLIC_URL` to the bucket's public URL or custom domain. Enable public
   access for the bucket/domain so lesson video and thumbnail URLs can be viewed.
4. Start the service:

   ```powershell
   npm install
   npm start
   ```

The `/api/upload-media` endpoint accepts multipart fields `file` and `folder`.
Allowed folders are `klaso/lessons`, `klaso/profiles`, and `klaso/media`.
Images and supported videos are stored in R2; uploads are limited to 500 MB.
The response contains the public `url` and R2 object `key`.

Keep the R2 credentials in this backend's `.env`; never put them in the Expo
app's environment.

## Admin email allowlist

Set `ADMIN_EMAILS` in the backend `.env` to one or more comma-separated email
addresses. Admin access is granted only after the account verifies its email.
The backend verifies the Firebase ID token, applies the admin custom claim, and
returns the result without sending the allowlist to the app.

Set `FIREBASE_PROJECT_ID` and provide `FIREBASE_SERVICE_ACCOUNT_JSON` for local
development, or configure Application Default Credentials in production. The
service account must be allowed to verify Firebase ID tokens and set custom
user claims.

## App environment

In `klaso/.env`, set `EXPO_PUBLIC_API_URL` to this backend's reachable URL and
set the Firebase `EXPO_PUBLIC_` values. No admin email list or Firebase service
account credentials belong in the app environment.
