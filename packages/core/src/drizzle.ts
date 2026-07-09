import { generateServiceDrizzleSchema } from "futonic";
import { spindeskServiceDefinition } from "./index.js";

export function generateSpindeskSchema(dialect: "pg" | "sqlite" | "mysql") {
	return generateServiceDrizzleSchema(spindeskServiceDefinition, dialect);
}
