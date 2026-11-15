import { createChildExtension } from "../../maestro/adapters/pi/child/protocol.ts";
import { renderChildWidget } from "./child-widget.ts";

export default createChildExtension(renderChildWidget);
