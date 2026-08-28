# Shiftly

Shift scheduling web app for Cybereason — Apple-style UI.

- **Workers**: sign in with their email, submit weekly availability (Morning / Evening / Night per day), and view their shifts plus the full team schedule once it's published.
- **Admin** (manager): sees everyone's availability in a matrix, builds the weekly schedule (with auto-fill, conflict warnings, and CSV export), manages the team, and publishes the schedule.

## Hosting

The app is a single static file — [`index.html`](index.html) — served with GitHub Pages.

> **Note on data:** on GitHub Pages the app runs in per-browser mode (each visitor's data is saved in their own browser via localStorage). The team-synced version, where worker submissions reach the admin live, runs at its claude.ai artifact URL. A shared backend (e.g. Supabase) is required to make the GitHub Pages version multi-user.
