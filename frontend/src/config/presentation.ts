// Presentation only: keep the existing services, settings and handlers intact.
export const presentation = {
  showUpdates: false,
  showNotificationSettings: false,
  showAbout: false,
  showOtherAIProviders: false,
  // Hides the Settings > Beta tab. The beta features themselves stay enabled
  // at their DEFAULT_BETA_FEATURES values; see types/betaFeatures.ts.
  showBetaSettings: false,
};
