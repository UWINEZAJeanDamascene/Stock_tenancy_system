# Adding Redis to Render (Step by Step)

## Step 1: Go to Render Dashboard

1. Open https://dashboard.render.com/
2. Log in to your account

## Step 2: Select Your Backend Service

1. Click on **"Web Services"** in the left sidebar
2. Find and click on your **stock-management** backend service (the Node.js/Express API)

## Step 3: Add Redis Addon

1. On your service page, look for the **"Environment"** tab in the left sidebar
2. Scroll down to the **"Add-ons"** section
3. Click **"+ Add add-on"** button

## Step 4: Select Redis

1. In the search box, type **"Redis"**
2. You'll see **"Render Redis"** - click on it

## Step 5: Choose Plan

1. Select **"Free"** plan (or $0/month)
   - 30 MB cache
   - Shared CPU
   - Expires after 30 days of inactivity (just redeploy to reactivate)
2. Click **"Create Redis"** button

## Step 6: Wait for Provisioning

Wait about 1-2 minutes for Redis to be created.

## Step 7: Verify REDIS_URL

After creation, Render automatically adds a `REDIS_URL` environment variable to your service. 

**To verify:**
1. Go to your service → **Environment** tab
2. Scroll down to **"Environment Variables"**
3. You should see `REDIS_URL` with a value like:
   ```
   redis://redis-12345.abcd.cloud.redislabs.com:12345
   ```

## Step 8: Redeploy Your Service

1. Go to your service page
2. Click **"Deployments"** tab
3. Click **"Redeploy"** (or make a small code change to trigger deploy)
4. Wait for deployment to complete

## Step 9: Check Logs

After redeploying, check your logs to confirm Redis is connected:
- You should see: `Redis connected successfully` and `Redis client ready`

---

## That's It! 🎉

Your caching layer is now active with:
- ✅ Session management with Redis
- ✅ Query caching (faster database responses)
- ✅ Distributed rate limiting

The system is **fail-open** - if Redis ever goes down, your API will still work (just without caching).
