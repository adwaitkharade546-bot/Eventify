# Eventify workflow updates

## Participant flow
1. The dashboard presents two role choices: Participant and Event Organizer.
2. Participants browse an event and submit the registration form. There is no checkout or payment step; events are shown as free participation.
3. The request is shown as pending until an organizer reviews it.
4. Organizers open **Registration requests** and can approve, reject, or request corrections.
5. Approved participants can download their participation ticket from **My tickets**. The current frontend demo downloads a text ticket containing the event, participant, registration ID, and approval status.

## Organizer flow
- The organizer dashboard includes registration request review and approval actions.
- Publishing an event adds it to the organizer's **My Events** list and to the public Home and Explore event listings. Participants can open its details and register for that specific event.
- The organizer sidebar includes **Switch to participant**.
- The participant dashboard includes **I'm an Event Organizer** and **I'm a Participant** role cards.

## Important implementation note
This is a React/Vite frontend prototype. Published events and registration records are saved in the browser's localStorage, so they remain after refresh and are visible when switching between participant and organizer views in the same browser. New registration submissions create records in the app, and organizer approval/rejection/correction actions update them. Data is not synchronized between different devices or browsers. For production, connect the same workflow to a backend API/database and issue secure PDF tickets after approval.

## Account profile
- The email entered during role login is shown in the dashboard sidebar and prefilled in **Profile settings**. Sign-up also captures the account name and contact details.
- Profile changes are saved in that browser's localStorage and persist after refresh.
- This prototype does not verify credentials or provide real authentication. Connect it to a backend identity service and database before using it for real accounts; passwords are not stored by the frontend.
