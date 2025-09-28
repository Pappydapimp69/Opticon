```markdown
# Panopticon-Inspired Game Design Project

## Core Design Principles (from Bentham's Panopticon)

### 1. Visibility (One-Way Transparency)
- Watcher sees many, observed cannot see the watcher.  
- Creates strong asymmetry of information.  
- In practice: the Watcher is human, limited by gaze and attention, but the *architecture* creates the illusion of omniscience.  

### 2. Uncertainty (The “Maybe I’m Being Watched” Effect)
- Subjects never know when surveillance is active.  
- Possibility of being observed is as impactful as actual observation.  
- Uncertainty creates psychological compliance: prisoners regulate themselves.  
- Game translation seed: tension comes from *doubt* more than direct capture.  

### 3. Internalized Control (Self-Policing)
- Fear of surveillance changes behavior even when the watcher is inactive.  
- Compliance is psychological, not purely enforced by external action.  
- Combined dynamic: **The Discipline Loop** — environment rewards self-regulation (slow but safe moves) while bluff signals create hesitation. Over time, paranoia alone shapes behavior.

### 4. Efficiency (Minimal Effort, Maximum Reach)
- Small number of watchers can control large populations.  
- Leverage comes from design rather than brute force.  
- **Segment 1: Watcher’s Action Economy** → Watcher has only one real action per round, yet all prisoners adapt as though under constant gaze.  
- **Segment 2: Prisoner Population Scaling** → More prisoners = stronger paranoia effect, since the Watcher’s limited actions ripple outward. Bluffing must be **selective, not universal** to preserve tension.  
- **Segment 3: Amplification Through Illusion** → Watcher doesn’t need to act every turn; even skipped or bluff turns keep prisoners cautious.  
- **Segment 4: Bluff Mechanic (Rotation + Feint System)** → Watcher can only rotate 90° per turn. Bluffs act as *secondary declarations* in other directions without changing real gaze.  
  - Example: Watcher facing North declares, “I’m looking East and West.” Prisoners in those zones feel targeted, though the Watcher is still locked North until next turn.  
  - On the following turn, Watcher may rotate East or West for real.  
  - Prisoners know these limitations (since roles rotate in multiplayer), but uncertainty lies in *intention*, not *rules*.  
  - Creates efficiency by spreading paranoia beyond the Watcher’s actual coverage.  

---

## Early Gameplay Concept (Turn-Based Variant)
- **Format:** Turn-based, grid-based board or digital game.  
- **Prisoners:** Take turns moving up to **3 spaces** north, south, east, or west.  
  - Moving **2 or more spaces** causes noise, revealing the **exact tile where the prisoner started** that turn.  
  - **Quiet Move (1 step):** Safe unless stepping on a noisy tile.  
- **Watcher:** Responds to noise cues.  
  - Cannot see everything at once, must choose where to look each turn.  
  - Rotation limited to 90° per turn, with bluff declarations.  
- **Dynamic:** Builds tension similar to *Stop Thief* — information is partial, indirect, and players bluff around uncertainty.  

---

## Map Layout: Donut Bands
- **Watcher’s Tower:** Solid, impassable center.  
- **Empty Moat (5 tiles thick):** Separates tower from Ring 1; prisoners cannot move inward.  
- **7 Playable Rings:** Each 5 tiles thick, wrapping around the tower.  
- **Quadrants:** Each ring divided into N/E/S/W sectors for Watcher coverage.  
- **Consistency:** Every ring includes standard tiles, noisy tiles, chokepoints, and interactable objects (like doors and switches).  

---

## Light & Vision System
- **Light Tiles:** Placed on the map, radiate illumination within a fixed radius (e.g., 3 tiles).  
- **Switches:** Linked to light tiles; toggling them on/off changes illumination. Silent, costs 1 movement point.  
- **Solid Objects:** Walls, doors, and cells block light from passing through.  

### **Visibility Levels**
- **0 = Dark:** Tile invisible to prisoners.  
- **1 = Outline:** Tile shape visible, contents unknown. Prisoners *can* move into it.  
- **2 = Foggy:** Tile visible but hazy — prisoners see objects but not their exact state (e.g., can tell there’s a door, but not if it’s locked).  
- **3 = Clear:** Fully visible — tile and all objects identified.  

### **Prisoner Field of View (FoV)**
- **Shape:** Radiates outward along the cardinal directions (N/E/S/W) from the prisoner’s tile.  
- **Range:** Maximum of 5 tiles in each direction.  
- **Blockers:** Walls, doors, and cells stop vision along that line.  
- **Light Interaction:** Only tiles with Visibility ≥ 1 appear in FoV. Darkness (0) is completely hidden.  
- **Dynamic Behavior:** As prisoners move, their visible corridors update — doors and shadows cut sightlines, switches can expand or shrink them.  

### **Watcher Field of View**
- Covers the **entire map** (all 7 rings).  
- Watcher never sees prisoners directly — their info comes from **noise cues, quadrant declarations, and light states.**  
- This preserves the illusion of omniscience.  

---

## Next Steps for Exploration
- Define distribution of **light tiles and switches** across rings using golden ratio cones.  
- Establish baseline **objects** per ring (doors, chokepoints, noisy tiles).  
- Determine **exit gate placement** in Ring 7.  
- Refine how the Watcher’s noise reports interact with **light levels** (lit = more precise, dark = vague).  

---

## Open Question
Should light sources in outer rings be **rarer but stronger** (wider radius), while inner rings are **denser but weaker** — or should all lights have the same radius regardless of position?
```
