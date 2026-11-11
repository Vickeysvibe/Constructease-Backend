/**
 * Shapes of the OLD (legacy JS app) MongoDB documents, read with the raw driver.
 * Every field is optional because legacy data was written by several versions of the app
 * (and by an Excel import that bypassed the mongoose hooks) — the mappers validate everything.
 */
import type { Connection, Types } from "mongoose";

type Id = Types.ObjectId;

interface Base {
  _id: Id;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface LEngineer extends Base {
  name?: string;
  companyName?: string;
  companyLogo?: string;
  companyDesc?: string;
  email?: string;
  phoneNo?: string;
  address?: string;
  password?: string;
}
export interface LSupervisor extends Base {
  name?: string;
  email?: string;
  address?: string;
  phoneNo?: string;
  password?: string;
  role?: "global" | "local";
  engineerId?: Id;
  isDel?: boolean;
}
export interface LSite extends Base {
  siteName?: string;
  siteAddress?: string;
  engineerId?: Id;
  supervisorsId?: Id[];
}
export interface LClient extends Base {
  name?: string;
  phoneNo?: string;
  address?: string;
  panGstNo?: string;
  siteId?: Id;
}
export interface LVendor extends Base {
  name?: string;
  ownerName?: string;
  address?: string;
  gstIn?: string;
  phoneNo?: string;
  siteId?: Id;
}
export interface LLabour extends Base {
  name?: string;
  phoneNo?: string;
  category?: string;
  subCategory?: string;
  wagesPerShift?: number;
  isDel?: boolean;
  /** an array in the old model (a labourer could work on several sites) */
  siteId?: Id[] | Id;
}
export interface LProduct extends Base {
  name?: string;
  description?: string;
  category?: string;
  unit?: string;
  siteId?: Id;
}
export interface LPurchaseOrder extends Base {
  siteId?: Id;
  vendorId?: Id;
  date?: Date;
  transport?: string;
  order?: { _id?: Id; productId?: Id; requiredQty?: number }[];
}
export interface LMaterialInward extends Base {
  POid?: Id;
  materials?: Id[];
  subTotal?: number;
  grandTotal?: number;
  siteId?: Id;
}
export interface LMaterial extends Base {
  productId?: Id;
  suppliedQty?: number;
  tax?: number;
  availableQty?: number;
  usedQty?: number;
  unitPrice?: number;
  siteId?: Id;
  fromVendor?: Id;
  POid?: Id;
}
export interface LPurchaseReturn extends Base {
  POid?: Id;
  order?: { materialId?: Id; returnQty?: number; tax?: number; subTotal?: number }[];
  grandTotal?: number;
  siteId?: Id;
}
export interface LLabourAttendance extends Base {
  siteId?: Id;
  date?: Date;
  attendance?: { labourId?: Id; shift?: number; status?: string }[];
}
export interface LSupervisorAttendance extends Base {
  siteId?: Id;
  date?: Date;
  attendance?: {
    supervisorId?: Id;
    location?: { address?: string; latitude?: number; longitude?: number };
    checkin?: Date[];
    checkout?: Date[];
  }[];
}
export interface LPayment extends Base {
  siteId?: Id;
  engineerId?: Id;
  type?: "vendor" | "client" | "labour" | "others";
  date?: Date;
  description?: string;
  name?: string;
  amount?: number;
  quantity?: number;
  unit?: string;
  costPerUnit?: number;
  paymentReceived?: number;
  paymentAs?: string;
  paymentBy?: string;
}
export interface LTodo extends Base {
  task?: string;
  start?: Date;
  end?: Date;
  additionalCols?: Record<string, unknown>;
  siteId?: Id;
}
export interface LWork extends Base {
  title?: string;
  description?: string;
  date?: Date;
  additionalCols?: Record<string, unknown>;
  siteId?: Id;
}
export interface LNote extends Base {
  title?: string;
  sheetsLink?: string;
  context?: string;
  siteId?: Id;
}

/** Old collection names = mongoose's default pluralisation of the old model() names. */
export const LEGACY_COLLECTIONS = {
  engineers: "engineers", // model("Engineers")
  supervisors: "supervisors", // model("Supervisors")
  sites: "sites", // model("Sites")
  clients: "clients", // model("Clients")
  vendors: "vendors", // model("Vendors")
  labours: "labours", // model("Labours")
  products: "products", // model("Products")
  purchaseOrders: "purchaseorders", // model("PurchaseOrders")
  materialInwards: "materialinwards", // model("MaterialInwards")
  materials: "materials", // model("Materials")
  purchaseReturns: "purchasereturns", // model("PurchaseReturns")
  labourAttendances: "labourattendances", // model("LabourAttendances")
  supervisorAttendances: "supervisorattendances", // model("SupervisorAttendances")
  payments: "payments", // model("Payments")
  todos: "todos", // model("Todos")
  works: "works", // model("Works")
  notes: "notes", // model("Notes")
} as const;

export interface LegacyData {
  engineers: LEngineer[];
  supervisors: LSupervisor[];
  sites: LSite[];
  clients: LClient[];
  vendors: LVendor[];
  labours: LLabour[];
  products: LProduct[];
  purchaseOrders: LPurchaseOrder[];
  materialInwards: LMaterialInward[];
  materials: LMaterial[];
  purchaseReturns: LPurchaseReturn[];
  labourAttendances: LLabourAttendance[];
  supervisorAttendances: LSupervisorAttendance[];
  payments: LPayment[];
  todos: LTodo[];
  works: LWork[];
  notes: LNote[];
}

/** Reads every legacy collection into memory, oldest first (the old app's data volume is small). */
export async function loadLegacy(source: Connection): Promise<LegacyData> {
  const db = source.db;
  if (!db) throw new Error("Legacy source connection is not open");
  const out: Record<string, unknown[]> = {};
  for (const [key, name] of Object.entries(LEGACY_COLLECTIONS)) {
    out[key] = await db.collection(name).find({}).sort({ createdAt: 1, _id: 1 }).toArray();
  }
  return out as unknown as LegacyData;
}
