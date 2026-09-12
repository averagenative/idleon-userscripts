
      // For the suite's auto-open: the lane goes null the moment the fishing spot is off screen.
      // Reusing the loop's own state rather than testing the screen again --
      // a second detector here would be one more thing to drift.
      return { loop, sync, toggle, active: () => lane != null };
    }
  };
