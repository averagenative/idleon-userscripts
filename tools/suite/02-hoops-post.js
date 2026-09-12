
      // For the suite's auto-open: the platform is found every frame the court is up.
      // Reusing the loop's own state rather than testing the screen again --
      // a second detector here would be one more thing to drift.
      return { loop, sync, toggle, active: () => plat != null };
    }
  };
