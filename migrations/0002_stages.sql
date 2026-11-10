-- Stage order must match STAGES in lib/rules.js.
INSERT OR IGNORE INTO stages (n,name,owner,exit_test) VALUES (0,'Sourced','Whoever found it','Logged with a link, location and asking price');
INSERT OR IGNORE INTO stages (n,name,owner,exit_test) VALUES (1,'Screened','Any agent','Fits the buy box; obvious deal-breakers ruled out');
INSERT OR IGNORE INTO stages (n,name,owner,exit_test) VALUES (2,'Underwriting','Any agent','Numbers in notes: price, income, costs, financing, return');
INSERT OR IGNORE INTO stages (n,name,owner,exit_test) VALUES (3,'Diligence','Any agent','Documents, legal, title and condition checked; risks listed');
INSERT OR IGNORE INTO stages (n,name,owner,exit_test) VALUES (4,'Memo ready','Any agent','One-page memo in notes: the ask, the case, the risks, the recommendation');
INSERT OR IGNORE INTO stages (n,name,owner,exit_test) VALUES (5,'Jay approval','Jay only','Jay approves or rejects');
INSERT OR IGNORE INTO stages (n,name,owner,exit_test) VALUES (6,'Offer & closing','Jay only','Offer made, contract signed, closed or fallen through');
INSERT OR IGNORE INTO stages (n,name,owner,exit_test) VALUES (7,'Verdict','Jay only','Closed, passed or killed, with the reason in notes');
