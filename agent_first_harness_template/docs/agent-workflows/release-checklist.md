# Release Checklist

Use this before production deployment, app release, or public demo.

## Checklist

- [ ] Product scope confirmed
- [ ] Critical flows verified
- [ ] Quality gate passed
- [ ] Security-sensitive changes reviewed
- [ ] Environment variables configured
- [ ] Migration/backward compatibility checked
- [ ] Rollback plan documented
- [ ] Analytics/logging verified
- [ ] Release notes prepared
- [ ] Known issues documented

## Mobile release (Android / iOS)

- [ ] Version name and build number / versionCode bumped
- [ ] Release signing uses CI secrets, not files in the repo
- [ ] Android: target SDK meets current Play requirement; Data safety form matches behaviour
- [ ] iOS: privacy manifest and App Store privacy labels match SDKs in use
- [ ] Ads/IAP/analytics SDK versions reviewed; test ads disabled in release build
- [ ] Release build smoke-tested on a real device per platform
- [ ] Crash reporting receives events from the release build
