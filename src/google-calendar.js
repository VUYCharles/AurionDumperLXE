'use strict';

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

/**
 * GoogleCalendarSync
 *
 * Wraps the Google Calendar API v3 to provide two operations:
 *
 *   deleteAllInRange(timeMin, timeMax)
 *     Removes every event previously created by this tool within
 *     the given time range. Events are identified by a private
 *     extended property (source=aurion-scraper) set at creation
 *     time. Pagination is handled automatically.
 *
 *   insertEvents(events)
 *     Creates new calendar events from a normalised event array.
 *     Rate-limiting is managed by inserting a short delay between
 *     each request to stay within Google's default quota.
 *
 * Authentication supports two modes:
 *   - Service Account (recommended for headless servers)
 *   - OAuth2 with a persistent refresh token
 *
 * The calendar is verified on authentication so that
 * configuration errors are caught before any scraping begins.
 */
class GoogleCalendarSync {
  constructor(config) {
    this.config     = config;
    this.calendarId = config.googleCalendarId;
    this.auth       = null;
    this.calendar   = null;
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  async authenticate() {
    if (this.config.serviceAccountKeyFile) {
      const keyFile = path.resolve(this.config.serviceAccountKeyFile);

      if (!fs.existsSync(keyFile)) {
        throw new Error(`Service account key file not found: ${keyFile}`);
      }

      const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });

      this.auth = await auth.getClient();
      console.log('[gcal] Authenticated via Service Account');

    } else if (this.config.oauth2Credentials) {
      const { clientId, clientSecret, redirectUri, refreshToken } =
        this.config.oauth2Credentials;

      const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      client.setCredentials({ refresh_token: refreshToken });
      this.auth = client;
      console.log('[gcal] Authenticated via OAuth2');

    } else {
      throw new Error(
        'No authentication method configured. ' +
        'Set serviceAccountKeyFile or oauth2Credentials in config.js.'
      );
    }

    this.calendar = google.calendar({ version: 'v3', auth: this.auth });

    // Verify calendar access immediately so failures are reported early
    console.log(`[gcal] Verifying access to calendar "${this.calendarId}"...`);
    try {
      const res = await this.calendar.calendars.get({ calendarId: this.calendarId });
      console.log(`[gcal] Calendar verified: "${res.data.summary}" (${res.data.id})`);
    } catch (err) {
      const detail = err.response?.data?.error || {};
      console.error(
        `[gcal] Cannot access calendar "${this.calendarId}": ` +
        `${detail.code || err.code} — ${detail.message || err.message}`
      );
      throw new Error(`Calendar verification failed: ${detail.message || err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Deletion
  // ---------------------------------------------------------------------------

  /**
   * Deletes all events tagged with source=aurion-scraper within
   * [timeMin, timeMax]. Called once before the scraping loop to
   * clear any data from previous runs, regardless of how many
   * weeks they covered.
   */
  async deleteAllInRange(timeMin, timeMax) {
    console.log(
      `[gcal] Deleting existing events from ${timeMin.slice(0, 10)} ` +
      `to ${timeMax.slice(0, 10)}...`
    );

    let deleted   = 0;
    let pageToken = null;

    do {
      const params = {
        calendarId:              this.calendarId,
        timeMin,
        timeMax,
        singleEvents:            true,
        maxResults:              500,
        privateExtendedProperty: 'source=aurion-scraper',
      };

      if (pageToken) params.pageToken = pageToken;

      const res = await this.calendar.events.list(params).catch((err) => {
        const d = err.response?.data?.error || {};
        console.error(`[gcal] List error: ${d.message || err.message}`);
        return { data: { items: [], nextPageToken: null } };
      });

      pageToken = res.data.nextPageToken || null;

      for (const ev of res.data.items || []) {
        try {
          await this.calendar.events.delete({
            calendarId: this.calendarId,
            eventId:    ev.id,
          });
          deleted++;
          await this._sleep(80);
        } catch (err) {
          // HTTP 410 Gone means already deleted — not an error
          if (err.response?.status !== 410) {
            const d = err.response?.data?.error || {};
            console.warn(`[gcal] Could not delete event ${ev.id}: ${d.message || err.message}`);
          }
        }
      }
    } while (pageToken);

    console.log(`[gcal] Deleted ${deleted} event(s)`);
    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Insertion
  // ---------------------------------------------------------------------------

  /**
   * Inserts a batch of events. Each event is tagged with a private
   * extended property so it can be identified and removed on the
   * next run.
   *
   * On a 404 response the method returns immediately, as this
   * indicates the calendar ID is wrong rather than a transient
   * failure.
   */
  async insertEvents(events) {
    if (!events?.length) return { created: 0, errors: 0 };

    let created = 0;
    let errors  = 0;

    for (const ev of events) {
      try {
        await this.calendar.events.insert({
          calendarId: this.calendarId,
          resource:   this._toGCalEvent(ev),
        });
        created++;
        await this._sleep(120);
      } catch (err) {
        const detail = err.response?.data?.error || {};
        console.error(
          `[gcal] Failed to insert "${ev.title}": ` +
          `${detail.message || err.message}`
        );

        if (detail.code === 404) {
          console.error('[gcal] Calendar not found — check googleCalendarId in config.js');
          return { created, errors: errors + (events.length - created) };
        }

        errors++;
      }
    }

    return { created, errors };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _toGCalEvent(ev) {
    const resource = {
      summary:     ev.title,
      description: ev.description || '',
      start:       { dateTime: ev.start, timeZone: 'Europe/Paris' },
      end:         { dateTime: ev.end,   timeZone: 'Europe/Paris' },
      extendedProperties: {
        private: { source: 'aurion-scraper' },
      },
    };

    if (ev.location) resource.location = ev.location;

    return resource;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = GoogleCalendarSync;
