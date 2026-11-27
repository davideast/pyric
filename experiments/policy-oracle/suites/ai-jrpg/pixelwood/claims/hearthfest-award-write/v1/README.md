# Hearthfest award writes

A temporary recipient owns the cycle 7 contribution document containing two pumpkins and two iron. A different signed-in account submits writes to that recipient’s award. The controller brackets the four SDK attempts with active-release checks, reads both documents after every attempt through an SDK client and the REST API, removes its fixtures, and restores the closed release on the isolated named database.

| Attempt | SDK verdict | Award points read back |
| --- | --- | --- |
| Signed-out create | DENY | Document absent |
| Signed-in create at 10 | ALLOW | 10 |
| Signed-in update to 11 | ALLOW | 11 |
| Signed-in delete | DENY | 11 |

The sibling native scoring claim derives 10 for these contributions. This claim scores the write decisions against the retained live receipt. Stock rules permit signed-in creates and updates, including an edit to the points field, and provide no delete permission.
