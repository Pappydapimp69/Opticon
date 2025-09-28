class Turf {
  constructor({
    id,
    name,
    typePath,
    density = 1,
    opacity = 1,
    iconKey = null,
  } = {}) {
    this.id = id;
    this.name = name;
    this.typePath = typePath ?? id;
    // DM-style defaults: density 1 blocks movement, opacity 1 blocks vision.
    this.density = density;
    this.opacity = opacity;
    this.iconKey = iconKey;
  }

  /**
   * Hook: runs when something tries to step onto this tile.
   * Return false to block entry, or true/undefined to allow.
   */
  onEnter(/* context */) {
    return undefined;
  }

  /**
   * Hook: runs when a character interacts with the tile without moving.
   */
  onInteract(/* context */) {
    return undefined;
  }
}

// Turf/Floor
class Floor extends Turf {
  constructor(options = {}) {
    super({
      id: "floor",
      name: "Floor",
      typePath: "/turf/floor",
      density: 0,
      opacity: 0,
      iconKey: "tex_floor",
      ...options,
    });
  }
}

// Turf/Wall
class Wall extends Turf {
  constructor(options = {}) {
    super({
      id: "wall",
      name: "Wall",
      typePath: "/turf/wall",
      density: 1,
      opacity: 1,
      iconKey: "tex_wall",
      ...options,
    });
  }
}

// Turf/Door
class Door extends Turf {
  constructor(options = {}) {
    super({
      id: "door_locked",
      name: "Locked Door",
      typePath: "/turf/door/locked",
      density: 1,
      opacity: 1,
      iconKey: "tex_obj_door",
      ...options,
    });
  }

  onInteract(context = {}) {
    return context.tryUnlock?.(this) ?? false;
  }
}

// Turf/Window
class Window extends Turf {
  constructor(options = {}) {
    super({
      id: "window",
      name: "Window",
      typePath: "/turf/window",
      density: 0,
      opacity: 0.3,
      iconKey: "tex_obj_glass",
      ...options,
    });
  }

  onEnter(context = {}) {
    if (context.makeNoise) {
      context.makeNoise({ source: this, volume: 1 });
    }
    return true;
  }
}

// Turf/Moat
class Moat extends Turf {
  constructor(options = {}) {
    super({
      id: "moat",
      name: "Moat",
      typePath: "/turf/moat",
      density: 1,
      opacity: 0.8,
      iconKey: "tex_moat",
      ...options,
    });
  }
}

window.Turfs = {
  Turf,
  Floor,
  Wall,
  Door,
  Window,
  Moat,
};
