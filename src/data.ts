/**
 * Mock store data for the Store Ops MCP server.
 *
 * This stands in for what would normally be a warehouse/POS database. It is
 * intentionally in-memory so the server has no external dependencies. The
 * replenishment tool mutates `onOrder` so repeated calls behave realistically
 * within a single server session.
 */

export interface Product {
  sku: string;
  name: string;
  category: string;
  /** Wholesale unit cost in USD. */
  unitCost: number;
  /** Retail price in USD. */
  retailPrice: number;
  /** Units currently sitting on the shelf / backroom. */
  onHand: number;
  /** Units already on an open replenishment order (not yet received). */
  onOrder: number;
  /** Below this on-hand level the item is considered low stock. */
  reorderPoint: number;
  /** Suggested order size when restocking. */
  reorderQuantity: number;
  /** Average units sold per day over the trailing window. */
  avgDailySales: number;
  /** Units sold over the trailing 30 days. */
  unitsSold30d: number;
  /** Units sold via POS over the trailing 24 hours (latest demand signal). */
  unitsSoldLast24h: number;
  supplierId: string;
}

export interface Store {
  storeId: string;
  name: string;
  region: string;
  products: Product[];
}

export interface Supplier {
  supplierId: string;
  name: string;
  leadTimeDays: number;
}

export const SUPPLIERS: Record<string, Supplier> = {
  "SUP-100": { supplierId: "SUP-100", name: "Northwind Grocery Distributors", leadTimeDays: 3 },
  "SUP-200": { supplierId: "SUP-200", name: "Pacific Beverage Co.", leadTimeDays: 5 },
  "SUP-300": { supplierId: "SUP-300", name: "Evergreen Home Goods", leadTimeDays: 7 },
};

export const STORES: Store[] = [
  {
    storeId: "STORE-001",
    name: "Downtown Market",
    region: "West",
    products: [
      {
        sku: "SKU-1001", name: "Whole Milk 1 Gal", category: "Dairy",
        unitCost: 2.1, retailPrice: 3.99, onHand: 8, onOrder: 0,
        reorderPoint: 20, reorderQuantity: 60, avgDailySales: 12, unitsSold30d: 360, unitsSoldLast24h: 14,
        supplierId: "SUP-100",
      },
      {
        sku: "SKU-1002", name: "Sparkling Water 12pk", category: "Beverages",
        unitCost: 4.5, retailPrice: 7.49, onHand: 45, onOrder: 0,
        reorderPoint: 30, reorderQuantity: 48, avgDailySales: 6, unitsSold30d: 180, unitsSoldLast24h: 5,
        supplierId: "SUP-200",
      },
      {
        sku: "SKU-1003", name: "Paper Towels 6-Roll", category: "Household",
        unitCost: 5.25, retailPrice: 9.99, onHand: 4, onOrder: 12,
        reorderPoint: 15, reorderQuantity: 36, avgDailySales: 3, unitsSold30d: 90, unitsSoldLast24h: 2,
        supplierId: "SUP-300",
      },
      {
        sku: "SKU-1004", name: "Cold Brew Coffee 32oz", category: "Beverages",
        unitCost: 3.8, retailPrice: 6.99, onHand: 22, onOrder: 0,
        reorderPoint: 18, reorderQuantity: 24, avgDailySales: 4, unitsSold30d: 120, unitsSoldLast24h: 4,
        supplierId: "SUP-200",
      },
    ],
  },
  {
    storeId: "STORE-002",
    name: "Lakeside Grocer",
    region: "Central",
    products: [
      {
        sku: "SKU-1001", name: "Whole Milk 1 Gal", category: "Dairy",
        unitCost: 2.1, retailPrice: 3.99, onHand: 30, onOrder: 0,
        reorderPoint: 20, reorderQuantity: 60, avgDailySales: 9, unitsSold30d: 270, unitsSoldLast24h: 8,
        supplierId: "SUP-100",
      },
      {
        sku: "SKU-2001", name: "Organic Eggs Dozen", category: "Dairy",
        unitCost: 3.2, retailPrice: 5.49, onHand: 6, onOrder: 0,
        reorderPoint: 24, reorderQuantity: 48, avgDailySales: 10, unitsSold30d: 300, unitsSoldLast24h: 11,
        supplierId: "SUP-100",
      },
      {
        sku: "SKU-2002", name: "Dish Soap 24oz", category: "Household",
        unitCost: 1.95, retailPrice: 3.79, onHand: 50, onOrder: 0,
        reorderPoint: 20, reorderQuantity: 36, avgDailySales: 2, unitsSold30d: 60, unitsSoldLast24h: 1,
        supplierId: "SUP-300",
      },
    ],
  },
  {
    storeId: "47",
    name: "Praha Vinohrady",
    region: "CZ-Prague",
    products: [
      {
        sku: "8847291", name: "Madeta butter 250g", category: "Dairy",
        unitCost: 1.95, retailPrice: 3.49, onHand: 4, onOrder: 0,
        reorderPoint: 24, reorderQuantity: 48, avgDailySales: 16, unitsSold30d: 480, unitsSoldLast24h: 18,
        supplierId: "SUP-100",
      },
      {
        sku: "SKU-1001", name: "Whole Milk 1 Gal", category: "Dairy",
        unitCost: 2.1, retailPrice: 3.99, onHand: 26, onOrder: 0,
        reorderPoint: 20, reorderQuantity: 60, avgDailySales: 11, unitsSold30d: 330, unitsSoldLast24h: 10,
        supplierId: "SUP-100",
      },
    ],
  },
  {
    storeId: "102",
    name: "Brno Kralovo Pole",
    region: "CZ-Brno",
    products: [
      {
        sku: "8847291", name: "Madeta butter 250g", category: "Dairy",
        unitCost: 1.95, retailPrice: 3.49, onHand: 5, onOrder: 0,
        reorderPoint: 24, reorderQuantity: 48, avgDailySales: 10, unitsSold30d: 300, unitsSoldLast24h: 9,
        supplierId: "SUP-100",
      },
    ],
  },
];

/** Look up a store by id (case-insensitive). */
export function findStore(storeId: string): Store | undefined {
  return STORES.find((s) => s.storeId.toLowerCase() === storeId.toLowerCase());
}

/** All known store ids, for error messages. */
export function knownStoreIds(): string[] {
  return STORES.map((s) => s.storeId);
}
