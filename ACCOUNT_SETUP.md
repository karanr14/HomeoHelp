# HomeoHelp account system setup

The project now uses **Supabase Auth** for email/password accounts. This keeps password handling out of HomeoHelp and works with the existing Vercel serverless structure.

## 1. Create a Supabase project

Create a project at Supabase, then open:

**Project Settings → API**

Copy:
- Project URL
- Publishable/anon key

Do **not** use or expose a `service_role` key in the browser.

## 2. Configure email/password authentication

In Supabase, open:

**Authentication → Providers → Email**

Enable email/password sign-in.

For the simplest local test, you can temporarily disable email confirmation. For a real deployment, keeping email confirmation enabled is generally preferable.

## 3. Add Vercel environment variables

In your Vercel project settings, add:

```text
SUPABASE_URL=your-project-url
SUPABASE_ANON_KEY=your-public-anon-or-publishable-key
GROQ_API_KEY=your-existing-groq-key
```

Redeploy after adding the variables.

For local development with Vercel CLI, put the same values in a local `.env` file. Do not commit that file.

## 4. Test the account system

Open the deployed HomeoHelp site.

1. Click **Account**.
2. Choose **Create account**.
3. Enter a name, email, and password.
4. Confirm the email if Supabase asks you to.
5. Sign in.
6. Click Account again and verify that your name/email appear.
7. Sign out and sign back in.

The browser stores the authentication session through Supabase Auth. Passwords are not written to HomeoHelp's localStorage.

## What changed in this stage

- Added an Account button to the sidebar/top area.
- Added sign-in and create-account UI.
- Added Supabase Auth initialization.
- Added `/api/config` to safely provide only the public Supabase project configuration.
- Made existing local chat storage user-namespaced as a transition (`homeohelp_chats:<user-id>`), so accounts do not accidentally share the same browser chat list.
- Existing `/api/chat` behavior remains unchanged.

## Next stage

Once account creation and sign-in work, the next step is to move chats/messages from browser localStorage into a database with Row Level Security, so each signed-in user can access only their own chats.


## Authorized account / subscription gate

HomeoHelp currently grants chat access only to the exact email:
`karanramnani201@gmail.com`

All other signed-in accounts see the subscription screen and are blocked from `/api/chat`. The server checks the Supabase access token, so changing browser JavaScript cannot bypass the gate.

To connect the Buy Subscription button, set `SUBSCRIPTION_URL` near the authentication code in `public/index.html` to your real checkout URL.
