import PlannerApp from "./planner/PlannerApp";
import { isServer } from "./planner/repository";
import ServerGate from "./planner/ServerGate";
export default function App() {
  return isServer ? (
    <ServerGate>
      <PlannerApp />
    </ServerGate>
  ) : (
    <PlannerApp />
  );
}
