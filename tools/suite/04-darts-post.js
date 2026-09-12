
      // For the suite's auto-open: the board is nulled by the wall gate and after 900ms stale.
      // Reusing the loop's own state rather than testing the screen again --
      // a second detector here would be one more thing to drift.
      return { loop, sync, toggle, active: () => board != null };
    }
  };
